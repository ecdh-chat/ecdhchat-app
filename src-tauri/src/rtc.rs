//! WebRTC for the Linux app. WebKitGTK, which the app runs in on Linux, ships without
//! RTCPeerConnection, so there the page's connection runs here instead, on webrtc-rs, and
//! public/js/rtc-bridge.js stands in for the browser API. Other systems' webviews have their own
//! WebRTC, and this is only built for Linux.
//!
//! Only the transport moves. The chat's own encryption (public/js/secure-channel.js) still runs
//! in the page on top of it and still binds both DTLS fingerprints, which it reads from the SDP
//! exactly as with a browser's connection. Each connection carries one ordered data channel and
//! no media: calls aren't available where this bridge is used.
//!
//! Frames cross between the page and this side in batches, one IPC round trip per batch rather
//! than per frame, and incoming ones are read only as fast as the page takes them (see Inbox).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::{Buf, Bytes};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tokio::sync::Notify;
use webrtc::api::APIBuilder;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::data::data_channel::DataChannel;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice::mdns::MulticastDnsMode;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::policy::ice_transport_policy::RTCIceTransportPolicy;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::signaling_state::RTCSignalingState;

/// The same limit the page puts on descriptions (MAX_SDP in public/js/messages.js).
const MAX_SDP: usize = 32 * 1024;
const MAX_CANDIDATE: usize = 1024;
const MAX_LABEL: usize = 64;
/// The page's own limit on a frame (MAX_FRAME_SIZE in public/js/secure-channel.js): it never sends
/// a bigger one and refuses any it receives. Under this size webrtc-rs queues a frame all at once,
/// so a write given up on (SEND_TIMEOUT) leaves nothing half sent.
const MAX_FRAME: usize = 64 * 1024;
/// A frame that can't get out for this long means the connection is gone. webrtc-rs keeps a write
/// waiting for room in its send queue, and if the other side has vanished, it waits forever.
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// The most one batch from the page may carry. The page holds back once a megabyte is waiting
/// (HIGH_WATER_MARK in public/js/peer.js), so its batches stay well under this.
const MAX_BATCH: usize = 4 * 1024 * 1024;
/// The most kept for the page to fetch. The page fetches as fast as frames arrive and comes
/// nowhere near this; if it stalls that long, the bridge stops reading and SCTP's flow control
/// holds the sender back, rather than this process buffering without limit. Only a last resort:
/// webrtc-rs tells the sender its window reopened only when more data arrives, so a sender held
/// back like this picks up again slowly.
const MAX_INBOX: usize = 64 * 1024 * 1024;
const MAX_ICE_SERVERS: usize = 8;
const MAX_URLS: usize = 8;
const MAX_FIELD: usize = 512;
/// A chat needs one connection. A few more cover a page that reloaded without closing its own.
const MAX_PEERS: usize = 4;
/// The page waits for what's buffered to drop below this before sending more (LOW_WATER_MARK
/// in public/js/peer.js).
const LOW_WATER_MARK: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    ice_servers: Vec<IceServer>,
    #[serde(default)]
    relay_only: bool,
    /// Always on for the page. Tests turn it off: two connections in one process can't answer
    /// each other's .local lookups on every system.
    #[serde(skip, default = "on")]
    mdns: bool,
    /// MAX_INBOX for the page. Tests lower it to reach it quickly.
    #[serde(skip, default = "max_inbox")]
    inbox_limit: usize,
}

fn on() -> bool {
    true
}

fn max_inbox() -> usize {
    MAX_INBOX
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IceServer {
    urls: Urls,
    #[serde(default)]
    username: String,
    #[serde(default)]
    credential: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Urls {
    One(String),
    Many(Vec<String>),
}

#[derive(Deserialize, Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Description {
    #[serde(rename = "type")]
    kind: String,
    sdp: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    candidate: String,
    #[serde(default)]
    sdp_mid: Option<String>,
    #[serde(default, rename = "sdpMLineIndex")]
    sdp_mline_index: Option<u16>,
}

/// What happens on a connection, in the order it happened.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Candidate { candidate: RTCIceCandidateInit },
    ConnectionState { state: String },
    SignalingState { state: String },
    /// The other side opened the data channel (the joiner learns about it this way).
    Channel { label: String },
    Open,
    Close,
    /// What's waiting to go out dropped below LOW_WATER_MARK. `total` is every byte that has
    /// gone out so far, the same running total each send returns.
    Drained { total: u64 },
}

/// Where a connection's events go: the page's channel, or a test.
pub trait Sink: Send + Sync + 'static {
    fn event(&self, event: Event);
}

struct PageSink(Channel);

impl Sink for PageSink {
    fn event(&self, event: Event) {
        if let Ok(json) = serde_json::to_string(&event) {
            let _ = self.0.send(InvokeResponseBody::Json(json));
        }
    }
}

/// Frames that arrived and wait for the page to fetch them (rtc_recv), already packed as one
/// batch. The page always has a fetch waiting, so frames that arrive while it's busy with the
/// last batch go out together in the next.
struct Inbox {
    state: Mutex<Inbound>,
    /// How much may wait before reading stops (MAX_INBOX).
    limit: usize,
    /// A frame arrived, or the channel closed.
    filled: Notify,
    /// The page took what was waiting.
    emptied: Notify,
}

#[derive(Default)]
struct Inbound {
    batch: Vec<u8>,
    closed: bool,
}

impl Inbox {
    fn new(limit: usize) -> Self {
        Inbox { state: Mutex::default(), limit, filled: Notify::new(), emptied: Notify::new() }
    }

    fn push(&self, frame: &[u8]) {
        if let Ok(mut inbound) = self.state.lock() {
            pack(frame, &mut inbound.batch);
        }
        self.filled.notify_one();
    }

    fn close(&self) {
        if let Ok(mut inbound) = self.state.lock() {
            inbound.closed = true;
        }
        self.filled.notify_one();
        self.emptied.notify_one();
    }

    /// Waits while the limit or more is waiting for the page.
    async fn room(&self) {
        loop {
            match self.state.lock() {
                Ok(inbound) if inbound.batch.len() >= self.limit && !inbound.closed => {}
                _ => return,
            }
            self.emptied.notified().await;
        }
    }

    /// Everything that arrived since the last call, waiting for something if nothing has. Empty
    /// once the channel has closed and everything that came before has been taken.
    async fn take(&self) -> Vec<u8> {
        loop {
            {
                let Ok(mut inbound) = self.state.lock() else { return Vec::new() };
                if !inbound.batch.is_empty() {
                    let batch = std::mem::take(&mut inbound.batch);
                    drop(inbound);
                    self.emptied.notify_one();
                    return batch;
                }
                if inbound.closed {
                    return Vec::new();
                }
            }
            self.filled.notified().await;
        }
    }
}

pub struct Peer {
    pc: Arc<RTCPeerConnection>,
    channel: Arc<Mutex<Option<Arc<RTCDataChannel>>>>,
    /// The channel's stream once it's open. Frames are written to it directly: RTCDataChannel::send
    /// holds a lock for as long as a write waits for room, which closing the channel then waits on.
    stream: Arc<Mutex<Option<Arc<DataChannel>>>>,
    /// Every byte handed to the channel so far.
    queued: Arc<AtomicU64>,
    inbox: Arc<Inbox>,
    sink: Arc<dyn Sink>,
}

impl Peer {
    pub async fn new(config: Config, sink: Arc<dyn Sink>) -> Result<Arc<Peer>, String> {
        let ice_servers = ice_servers(config.ice_servers)?;
        let mut settings = SettingEngine::default();
        // Like browsers: this device's addresses go out as random .local names, and the other
        // side's .local names are looked up.
        settings.set_ice_multicast_dns_mode(if config.mdns { MulticastDnsMode::QueryAndGather } else { MulticastDnsMode::Disabled });
        // The channel is read by read_frames(), which can wait for the page, rather than pushed
        // to on_message as fast as it arrives.
        settings.detach_data_channels();
        let api = APIBuilder::new().with_setting_engine(settings).build();
        let pc = api
            .new_peer_connection(RTCConfiguration {
                ice_servers,
                ice_transport_policy: if config.relay_only { RTCIceTransportPolicy::Relay } else { RTCIceTransportPolicy::All },
                ..Default::default()
            })
            .await
            .map_err(error)?;
        let peer = Arc::new(Peer {
            pc: Arc::new(pc),
            channel: Arc::new(Mutex::new(None)),
            stream: Arc::new(Mutex::new(None)),
            queued: Arc::new(AtomicU64::new(0)),
            inbox: Arc::new(Inbox::new(config.inbox_limit)),
            sink,
        });

        let sink = peer.sink.clone();
        peer.pc.on_ice_candidate(Box::new(move |candidate| {
            if let Some(candidate) = candidate.and_then(|candidate| candidate.to_json().ok()) {
                sink.event(Event::Candidate { candidate });
            }
            Box::pin(async {})
        }));
        let sink = peer.sink.clone();
        peer.pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
            sink.event(Event::ConnectionState { state: state.to_string() });
            Box::pin(async {})
        }));
        let sink = peer.sink.clone();
        peer.pc.on_signaling_state_change(Box::new(move |state: RTCSignalingState| {
            sink.event(Event::SignalingState { state: state.to_string() });
            Box::pin(async {})
        }));
        let weak = Arc::downgrade(&peer);
        peer.pc.on_data_channel(Box::new(move |channel| {
            let weak = weak.clone();
            Box::pin(async move {
                if let Some(peer) = weak.upgrade() {
                    peer.sink.event(Event::Channel { label: channel.label().to_owned() });
                    peer.attach(channel).await;
                }
            })
        }));
        Ok(peer)
    }

    /// The creator's side of the one data channel. Like peer.js, a second one is refused.
    pub async fn create_channel(&self, label: &str) -> Result<(), String> {
        if label.len() > MAX_LABEL {
            return Err("label too long".into());
        }
        if self.channel.lock().map_err(error)?.is_some() {
            return Err("already has a channel".into());
        }
        let channel = self.pc.create_data_channel(label, None).await.map_err(error)?;
        self.attach(channel).await;
        Ok(())
    }

    async fn attach(&self, channel: Arc<RTCDataChannel>) {
        let taken = match self.channel.lock() {
            Ok(mut slot) if slot.is_none() => {
                *slot = Some(channel.clone());
                true
            }
            _ => false,
        };
        if !taken {
            let _ = channel.close().await;
            return;
        }
        // Detached (see new()), the open channel is used through its stream: read_frames() reads it
        // and reports its closing, and send() writes to it.
        let (sink, inbox, queued, slot) = (self.sink.clone(), self.inbox.clone(), self.queued.clone(), self.stream.clone());
        let weak = Arc::downgrade(&channel);
        channel.on_open(Box::new(move || {
            let (sink, inbox, queued, slot, weak) = (sink.clone(), inbox.clone(), queued.clone(), slot.clone(), weak.clone());
            Box::pin(async move {
                let Some(channel) = weak.upgrade() else { return };
                let Ok(stream) = channel.detach().await else {
                    inbox.close();
                    sink.event(Event::Close);
                    return;
                };
                stream.set_buffered_amount_low_threshold(LOW_WATER_MARK);
                let (drained_sink, weak_stream) = (sink.clone(), Arc::downgrade(&stream));
                stream.on_buffered_amount_low(Box::new(move || {
                    if let Some(stream) = weak_stream.upgrade() {
                        drained_sink.event(Event::Drained { total: drained(&queued, &stream) });
                    }
                    Box::pin(async {})
                }));
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(stream.clone());
                }
                sink.event(Event::Open);
                tauri::async_runtime::spawn(read_frames(stream, inbox, sink));
            })
        }));
    }

    /// setLocalDescription() with no arguments: an answer when an offer is waiting, otherwise an
    /// offer. Returns the description to signal, with any candidates gathered so far.
    pub async fn set_local(&self) -> Result<Description, String> {
        let description = if self.pc.signaling_state() == RTCSignalingState::HaveRemoteOffer {
            self.pc.create_answer(None).await
        } else {
            self.pc.create_offer(None).await
        }
        .map_err(error)?;
        self.pc.set_local_description(description).await.map_err(error)?;
        let local = self.pc.local_description().await.ok_or("no local description")?;
        Ok(Description { kind: local.sdp_type.to_string(), sdp: local.sdp })
    }

    pub async fn set_remote(&self, description: Description) -> Result<(), String> {
        if description.sdp.len() > MAX_SDP {
            return Err("description too long".into());
        }
        let description = match description.kind.as_str() {
            "offer" => RTCSessionDescription::offer(description.sdp),
            "answer" => RTCSessionDescription::answer(description.sdp),
            _ => return Err("unexpected description type".into()),
        }
        .map_err(error)?;
        self.pc.set_remote_description(description).await.map_err(error)
    }

    pub async fn add_candidate(&self, candidate: Candidate) -> Result<(), String> {
        if candidate.candidate.len() > MAX_CANDIDATE || candidate.sdp_mid.as_ref().is_some_and(|mid| mid.len() > MAX_LABEL) {
            return Err("candidate too long".into());
        }
        self.pc
            .add_ice_candidate(RTCIceCandidateInit {
                candidate: candidate.candidate,
                sdp_mid: candidate.sdp_mid,
                sdp_mline_index: candidate.sdp_mline_index,
                username_fragment: None,
            })
            .await
            .map_err(error)
    }

    /// Sends a batch of frames from the page, in order, and returns how many bytes have gone out
    /// so far, in total. A write waits while webrtc-rs's send queue is full, which paces the page.
    pub async fn send(&self, batch: Vec<u8>) -> Result<u64, String> {
        if batch.len() > MAX_BATCH {
            return Err("batch too large".into());
        }
        let frames = unpack(batch)?;
        let stream = self.stream.lock().map_err(error)?.clone().ok_or("not open")?;
        for frame in frames {
            let length = frame.len() as u64;
            tokio::time::timeout(SEND_TIMEOUT, stream.write(&frame)).await.map_err(|_| "the connection is stuck")?.map_err(error)?;
            self.queued.fetch_add(length, Ordering::SeqCst);
        }
        Ok(drained(&self.queued, &stream))
    }

    /// The frames that arrived since the last call, as one batch (see Inbox::take).
    pub async fn recv(&self) -> Vec<u8> {
        self.inbox.take().await
    }

    pub async fn close(&self) {
        self.inbox.close();
        let channel = self.channel.lock().ok().and_then(|slot| slot.clone());
        if let Some(channel) = channel {
            let _ = channel.close().await;
        }
        let _ = self.pc.close().await;
    }
}

/// How many bytes have gone out so far, in total. The page gets this rather than what's still
/// buffered: reports can reach it out of order, and a running total can't go stale (it keeps
/// the largest), where an older "1 MB buffered" landing last would stall it for good.
///
/// Read in this order, a send in between can only make the total come out smaller than it is,
/// which holds the page back until the next report instead of letting it overfill the buffer.
fn drained(queued: &AtomicU64, stream: &DataChannel) -> u64 {
    let queued = queued.load(Ordering::SeqCst);
    queued.saturating_sub(stream.buffered_amount() as u64)
}

/// Reads the channel into the inbox, but only while the page keeps up: with MAX_INBOX waiting
/// it stops, and SCTP's flow control holds the sender back, so a peer can't make this process
/// buffer without limit.
async fn read_frames(channel: Arc<DataChannel>, inbox: Arc<Inbox>, sink: Arc<dyn Sink>) {
    let mut buffer = vec![0; MAX_FRAME];
    loop {
        inbox.room().await;
        match channel.read_data_channel(&mut buffer).await {
            // The page only ever sends binary; text would be someone else's doing.
            Ok((_, true)) => {}
            Ok((length, false)) if length > 0 => inbox.push(&buffer[..length]),
            // Nothing read means the stream ended. A frame over MAX_FRAME ends it too.
            _ => break,
        }
    }
    inbox.close();
    sink.event(Event::Close);
}

/// A batch carries frames in order, each as its length (4 bytes, little-endian) and then its
/// bytes. public/js/rtc-bridge.js packs and unpacks the same way.
fn pack(frame: &[u8], batch: &mut Vec<u8>) {
    batch.extend_from_slice(&(frame.len() as u32).to_le_bytes());
    batch.extend_from_slice(frame);
}

fn unpack(batch: Vec<u8>) -> Result<Vec<Bytes>, String> {
    let mut rest = Bytes::from(batch);
    let mut frames = Vec::new();
    while !rest.is_empty() {
        if rest.len() < 4 {
            return Err("cut-off frame length".into());
        }
        let length = rest.get_u32_le() as usize;
        if length == 0 || length > MAX_FRAME || length > rest.len() {
            return Err("bad frame length".into());
        }
        frames.push(rest.split_to(length));
    }
    Ok(frames)
}

fn ice_servers(servers: Vec<IceServer>) -> Result<Vec<RTCIceServer>, String> {
    if servers.len() > MAX_ICE_SERVERS {
        return Err("too many ICE servers".into());
    }
    servers
        .into_iter()
        .map(|server| {
            let urls = match server.urls {
                Urls::One(url) => vec![url],
                Urls::Many(urls) => urls,
            };
            let too_long = |value: &str| value.len() > MAX_FIELD;
            if urls.len() > MAX_URLS || urls.iter().any(|url| too_long(url)) || too_long(&server.username) || too_long(&server.credential) {
                return Err("ICE server too long".to_owned());
            }
            if !urls.iter().all(|url| url.starts_with("stun:") || url.starts_with("turn:") || url.starts_with("turns:")) {
                return Err("not an ICE server".to_owned());
            }
            Ok(RTCIceServer { urls, username: server.username, credential: server.credential })
        })
        .collect()
}

fn error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[derive(Default)]
pub struct RtcState {
    next: AtomicU32,
    peers: Mutex<HashMap<u32, Arc<Peer>>>,
}

impl RtcState {
    fn get(&self, id: u32) -> Result<Arc<Peer>, String> {
        self.peers.lock().map_err(error)?.get(&id).cloned().ok_or_else(|| "no such connection".into())
    }
}

#[tauri::command]
pub async fn rtc_create(state: tauri::State<'_, RtcState>, config: Config, events: Channel) -> Result<u32, String> {
    let peer = Peer::new(config, Arc::new(PageSink(events))).await?;
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    // A page that reloaded never closed its old connections; the oldest make room.
    let stale: Vec<Arc<Peer>> = {
        let mut peers = state.peers.lock().map_err(error)?;
        let mut stale = Vec::new();
        while peers.len() >= MAX_PEERS {
            let Some(&oldest) = peers.keys().min() else { break };
            stale.extend(peers.remove(&oldest));
        }
        peers.insert(id, peer);
        stale
    };
    // Closing can wait on the network, and a new chat shouldn't wait for old ones.
    for peer in stale {
        tauri::async_runtime::spawn(async move { peer.close().await });
    }
    Ok(id)
}

#[tauri::command]
pub async fn rtc_create_channel(state: tauri::State<'_, RtcState>, id: u32, label: String) -> Result<(), String> {
    state.get(id)?.create_channel(&label).await
}

#[tauri::command]
pub async fn rtc_set_local(state: tauri::State<'_, RtcState>, id: u32) -> Result<Description, String> {
    state.get(id)?.set_local().await
}

#[tauri::command]
pub async fn rtc_set_remote(state: tauri::State<'_, RtcState>, id: u32, description: Description) -> Result<(), String> {
    state.get(id)?.set_remote(description).await
}

#[tauri::command]
pub async fn rtc_add_candidate(state: tauri::State<'_, RtcState>, id: u32, candidate: Candidate) -> Result<(), String> {
    state.get(id)?.add_candidate(candidate).await
}

/// A batch of frames is the raw request body and the connection is named in a header, so file
/// chunks don't go through JSON.
#[tauri::command]
pub async fn rtc_send(state: tauri::State<'_, RtcState>, request: Request<'_>) -> Result<u64, String> {
    let id = request
        .headers()
        .get("x-rtc-peer")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
        .ok_or("no connection named")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected bytes".into()) };
    let bytes = bytes.clone();
    state.get(id)?.send(bytes).await
}

/// Answers with every frame that arrived since the page last asked, as one raw batch, once there
/// is one. The page keeps one of these waiting, so a busy connection costs a round trip per batch
/// rather than per frame. An empty answer means the channel closed.
#[tauri::command]
pub async fn rtc_recv(state: tauri::State<'_, RtcState>, id: u32) -> Result<Response, String> {
    let peer = state.get(id)?;
    Ok(Response::new(peer.recv().await))
}

#[tauri::command]
pub async fn rtc_close(state: tauri::State<'_, RtcState>, id: u32) -> Result<(), String> {
    let peer = state.peers.lock().map_err(error)?.remove(&id);
    if let Some(peer) = peer {
        peer.close().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::mpsc;

    struct TestSink(mpsc::UnboundedSender<Event>);

    impl Sink for TestSink {
        fn event(&self, event: Event) {
            let _ = self.0.send(event);
        }
    }

    type Received = mpsc::UnboundedReceiver<Event>;

    async fn peer_with_inbox(inbox_limit: usize) -> (Arc<Peer>, Received) {
        let (tx, rx) = mpsc::unbounded_channel();
        let config = Config { ice_servers: vec![], relay_only: false, mdns: false, inbox_limit };
        (Peer::new(config, Arc::new(TestSink(tx))).await.unwrap(), rx)
    }

    async fn peer() -> (Arc<Peer>, Received) {
        peer_with_inbox(MAX_INBOX).await
    }

    /// Hands every candidate from one side to the other, like the signaling server does.
    fn forward_candidates(mut from: Received, to: Arc<Peer>) -> Received {
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(event) = from.recv().await {
                if let Event::Candidate { candidate } = &event {
                    let candidate = Candidate { candidate: candidate.candidate.clone(), sdp_mid: candidate.sdp_mid.clone(), sdp_mline_index: candidate.sdp_mline_index };
                    let _ = to.add_candidate(candidate).await;
                } else if tx.send(event).is_err() {
                    break;
                }
            }
        });
        rx
    }

    async fn next_matching(rx: &mut Received, wanted: impl Fn(&Event) -> bool) -> Event {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let event = rx.recv().await.expect("sink closed");
                if wanted(&event) {
                    return event;
                }
            }
        })
        .await
        .expect("timed out")
    }

    async fn connect() -> (Arc<Peer>, Received, Arc<Peer>, Received) {
        connect_with_inbox(MAX_INBOX).await
    }

    async fn connect_with_inbox(joiner_inbox: usize) -> (Arc<Peer>, Received, Arc<Peer>, Received) {
        let (creator, creator_rx) = peer().await;
        let (joiner, joiner_rx) = peer_with_inbox(joiner_inbox).await;
        let creator_rx = forward_candidates(creator_rx, joiner.clone());
        let joiner_rx = forward_candidates(joiner_rx, creator.clone());
        creator.create_channel("ecdh.chat").await.unwrap();
        let offer = creator.set_local().await.unwrap();
        assert_eq!(offer.kind, "offer");
        joiner.set_remote(offer).await.unwrap();
        let answer = joiner.set_local().await.unwrap();
        assert_eq!(answer.kind, "answer");
        creator.set_remote(answer).await.unwrap();
        (creator, creator_rx, joiner, joiner_rx)
    }

    async fn open() -> (Arc<Peer>, Received, Arc<Peer>, Received) {
        open_with_inbox(MAX_INBOX).await
    }

    async fn open_with_inbox(joiner_inbox: usize) -> (Arc<Peer>, Received, Arc<Peer>, Received) {
        let (creator, mut creator_rx, joiner, mut joiner_rx) = connect_with_inbox(joiner_inbox).await;
        let _ = next_matching(&mut creator_rx, |event| *event == Event::Open).await;
        let _ = next_matching(&mut joiner_rx, |event| *event == Event::Open).await;
        (creator, creator_rx, joiner, joiner_rx)
    }

    fn batch(frames: &[Vec<u8>]) -> Vec<u8> {
        let mut batch = Vec::new();
        for frame in frames {
            pack(frame, &mut batch);
        }
        batch
    }

    /// Fetches batches the way the page does until `count` frames have come.
    async fn receive(peer: &Peer, count: usize) -> Vec<Bytes> {
        let mut frames = Vec::new();
        while frames.len() < count {
            let batch = tokio::time::timeout(Duration::from_secs(20), peer.recv()).await.expect("timed out");
            assert!(!batch.is_empty(), "closed after {} frames", frames.len());
            frames.extend(unpack(batch).unwrap());
        }
        frames
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn two_bridges_connect_and_frames_arrive_in_order() {
        let (creator, mut creator_rx, joiner, mut joiner_rx) = connect().await;
        let _ = next_matching(&mut creator_rx, |event| *event == Event::Open).await;
        let channel = next_matching(&mut joiner_rx, |event| matches!(event, Event::Channel { .. })).await;
        assert_eq!(channel, Event::Channel { label: "ecdh.chat".into() });
        let _ = next_matching(&mut joiner_rx, |event| *event == Event::Open).await;

        let frames: Vec<Vec<u8>> = (0u8..50).map(|n| vec![n; 60 * 1024]).collect();
        for some in frames.chunks(10) {
            creator.send(batch(some)).await.unwrap();
        }
        let received = receive(&joiner, frames.len()).await;
        assert_eq!(received.len(), frames.len());
        assert!(received.iter().zip(&frames).all(|(got, sent)| got[..] == sent[..]));
        joiner.send(batch(&[b"back".to_vec()])).await.unwrap();
        assert_eq!(&receive(&creator, 1).await[0][..], b"back");

        // Closing reaches the other side as an event, and its fetch then comes back empty.
        joiner.close().await;
        let _ = next_matching(&mut creator_rx, |event| *event == Event::Close).await;
        assert!(creator.recv().await.is_empty());
        creator.close().await;
    }

    /// A page that stops fetching can't be made to hold whatever the other side sends: at its
    /// limit this side stops reading and SCTP's flow control holds the sender back; fetching
    /// again carries on, in order.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_page_that_stops_fetching_holds_the_sender_back() {
        const LIMIT: usize = 256 * 1024;
        let (creator, _creator_rx, joiner, _joiner_rx) = open_with_inbox(LIMIT).await;
        let frames: Vec<Vec<u8>> = (0..128).map(|n| vec![n as u8; 60 * 1024]).collect();
        let total = frames.len() * 60 * 1024;
        // Writes wait once the sender's own queue is full, as they do in the app.
        let sender = {
            let (creator, frames) = (creator.clone(), frames.clone());
            tokio::spawn(async move {
                for some in frames.chunks(16) {
                    creator.send(batch(some)).await.unwrap();
                }
            })
        };
        // Waits until the sender stops getting anywhere.
        let stream = creator.stream.lock().unwrap().clone().unwrap();
        let mut gone = drained(&creator.queued, &stream);
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = drained(&creator.queued, &stream);
            if now - gone < 64 * 1024 {
                break;
            }
            gone = now;
        }
        let waiting = joiner.inbox.state.lock().unwrap().batch.len();
        assert!(waiting <= LIMIT + MAX_FRAME, "{waiting} bytes waiting for the page");
        assert!(gone < total as u64 / 2, "{gone} of {total} bytes went out");
        assert!(!sender.is_finished(), "the sender wasn't held back");

        let received = receive(&joiner, 16).await;
        assert!(received.iter().zip(&frames).all(|(got, sent)| got[..] == sent[..]));
        // A write still waiting for room doesn't stop either side from closing.
        tokio::time::timeout(Duration::from_secs(20), async {
            creator.close().await;
            joiner.close().await;
        })
        .await
        .expect("closing hung");
        sender.abort();
    }

    /// How fast a file goes from one bridge to another in this process, with the page's
    /// batching and backpressure. Not part of the normal run:
    /// cargo test --release throughput -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn throughput() {
        const CHUNK: usize = 60 * 1024;
        const TOTAL: usize = 20 * 1024 * 1024;
        // HIGH_WATER_MARK in public/js/peer.js.
        const HIGH_WATER_MARK: u64 = 1024 * 1024;
        let (creator, mut creator_rx, joiner, _joiner_rx) = open().await;

        let started = std::time::Instant::now();
        let sender = tokio::spawn(async move {
            // About what the page batches while the previous batch is on its way.
            let frames = vec![vec![7; CHUNK]; 16];
            let mut sent = 0;
            while sent < TOTAL as u64 {
                sent += (CHUNK * frames.len()) as u64;
                let mut drained = creator.send(batch(&frames)).await.unwrap();
                while sent - drained > HIGH_WATER_MARK {
                    if let Event::Drained { total } = next_matching(&mut creator_rx, |event| matches!(event, Event::Drained { .. })).await {
                        drained = drained.max(total);
                    }
                }
            }
            creator
        });
        let mut received = 0;
        while received < TOTAL {
            received += unpack(joiner.recv().await).unwrap().iter().map(Bytes::len).sum::<usize>();
        }
        let seconds = started.elapsed().as_secs_f64();
        println!("{} MB in {seconds:.2} s: {:.1} MB/s", TOTAL >> 20, (TOTAL >> 20) as f64 / seconds);
        sender.await.unwrap().close().await;
        joiner.close().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_swapped_dtls_fingerprint_never_connects() {
        let (creator, creator_rx) = peer().await;
        let (joiner, joiner_rx) = peer().await;
        let mut creator_rx = forward_candidates(creator_rx, joiner.clone());
        let _joiner_rx = forward_candidates(joiner_rx, creator.clone());
        creator.create_channel("ecdh.chat").await.unwrap();
        let offer = creator.set_local().await.unwrap();
        joiner.set_remote(offer).await.unwrap();
        let mut answer = joiner.set_local().await.unwrap();
        // Someone in the middle swaps in a certificate fingerprint that isn't the joiner's.
        let line = answer.sdp.lines().find(|line| line.starts_with("a=fingerprint:sha-256 ")).unwrap().to_owned();
        let forged = format!("a=fingerprint:sha-256 {}", vec!["AB"; 32].join(":"));
        answer.sdp = answer.sdp.replace(&line, &forged);
        creator.set_remote(answer).await.unwrap();

        let state = next_matching(&mut creator_rx, |event| {
            *event == Event::Open || matches!(event, Event::ConnectionState { state } if state == "failed" || state == "connected")
        })
        .await;
        assert_eq!(state, Event::ConnectionState { state: "failed".into() });
        creator.close().await;
        joiner.close().await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn oversized_input_is_refused() {
        let (creator, _rx) = peer().await;
        let huge = Description { kind: "offer".into(), sdp: "v=0\r\n".repeat(MAX_SDP) };
        assert!(creator.set_remote(huge).await.is_err());
        assert!(creator.set_remote(Description { kind: "pranswer".into(), sdp: "v=0".into() }).await.is_err());
        let long = Candidate { candidate: "a".repeat(MAX_CANDIDATE + 1), sdp_mid: None, sdp_mline_index: None };
        assert!(creator.add_candidate(long).await.is_err());
        assert!(creator.create_channel(&"x".repeat(MAX_LABEL + 1)).await.is_err());
        creator.create_channel("ecdh.chat").await.unwrap();
        assert!(creator.create_channel("second").await.is_err());
        assert_eq!(creator.send(vec![0; MAX_BATCH + 1]).await, Err("batch too large".into()));
        creator.close().await;
    }

    #[test]
    fn batches_round_trip_and_malformed_ones_are_refused() {
        let frames = vec![b"one".to_vec(), vec![2; 60 * 1024], b"three".to_vec()];
        let unpacked = unpack(batch(&frames)).unwrap();
        assert_eq!(unpacked.len(), 3);
        assert!(unpacked.iter().zip(&frames).all(|(got, sent)| got[..] == sent[..]));
        assert!(unpack(Vec::new()).unwrap().is_empty());
        assert!(unpack(vec![5, 0, 0, 0, 1]).is_err(), "says 5 bytes, has 1");
        assert!(unpack(vec![1, 0]).is_err(), "cut-off length");
        assert!(unpack(batch(&[Vec::new()])).is_err(), "empty frame");
        assert!(unpack(batch(&[vec![0; MAX_FRAME + 1]])).is_err(), "frame too large");
    }

    #[test]
    fn ice_servers_are_checked() {
        let parse = |json: &str| ice_servers(serde_json::from_str::<Config>(json).unwrap().ice_servers);
        let servers = parse(r#"{"iceServers":[{"urls":"stun:a:3478"},{"urls":["turn:a:3478"],"username":"u","credential":"c"}]}"#).unwrap();
        assert_eq!(servers[0].urls, vec!["stun:a:3478"]);
        assert_eq!(servers[1].username, "u");
        assert!(parse(r#"{"iceServers":[{"urls":"https://evil.example"}]}"#).is_err());
        assert!(serde_json::from_str::<Config>(r#"{"iceServers":[],"extra":1}"#).is_err());
    }
}
