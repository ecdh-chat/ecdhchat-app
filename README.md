# ecdh.chat app

The source of the [ecdh.chat](https://ecdh.chat) app for Windows, Linux and Android: private, peer-to-peer chat, encrypted end to end, with nothing stored.

It's published so you don't have to trust our installers. Read the code, then build the app yourself.

- How a chat works: [ecdh.chat/about](https://ecdh.chat/about)
- Ready-made installers: [ecdh.chat/download](https://ecdh.chat/download)

## Build it yourself

You need [Node.js](https://nodejs.org) 22 or newer and [Rust](https://rustup.rs) (stable), plus:

- **Windows:** [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**, and WebView2, which Windows 10 and 11 normally already have.
- **Linux:** WebKitGTK and a few libraries. On Ubuntu or Debian:
  ```
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

Then, in this folder:

```
npm ci
npm run app:build
```

The installers are written to `src-tauri/target/release/bundle/`: an NSIS installer on Windows, an AppImage and a .deb on Linux. To run the app without installing it, start `src-tauri/target/release/ecdh-chat` (`ecdh-chat.exe` on Windows).

To run the tests:

```
npm test                    # encryption, message format, file transfer, links, the Linux connection bridge
cd src-tauri && cargo test  # the app's Rust side
```

### Android

You also need JDK 21, the Android SDK with platform 37, build tools and NDK 30 (`ANDROID_HOME` and `NDK_HOME` set), and Rust's Android targets:

```
rustup target add aarch64-linux-android armv7-linux-androideabi
npm ci
npm run app:android:build
```

The APK lands in `src-tauri/gen/android/app/build/outputs/apk/universal/release/`, unsigned. Sign it with your own key (`apksigner sign --ks your.jks …`) to install it. Android won't install it over ours or ours over it, because the two are signed with different keys: uninstall one first.

## What to look at

| Where | What it is |
|---|---|
| `public/js/secure-channel.js` | The key exchange and encryption: ECDH P-256, HKDF-SHA-256, AES-256-GCM |
| `public/js/connection.js`, `peer.js` | The direct WebRTC connection to the other person |
| `src-tauri/src/rtc.rs`, `public/js/rtc-bridge.js` | On Linux, where the system's web engine has no WebRTC, the app makes that connection itself with [webrtc-rs](https://github.com/webrtc-rs/webrtc). The encryption above runs unchanged on top of it. |
| `src-tauri/capabilities/desktop.json`, `mobile.json` | Everything the chat page is allowed to ask the desktop or phone app to do |
| `src-tauri/src/lib.rs` | The window, invite links, and `SERVER`, the only server the app talks to |
| `src-tauri/src/updates.rs` | Update checks: an update installs only after you agree, and only if it's signed with our release key |
| `src-tauri/tauri.conf.json` | The Content Security Policy and the update key's public half |
| `src-tauri/tauri.windows.conf.json`, `tauri.linux.conf.json` | Each system's installer settings |
| `src-tauri/gen/android/app/src/main/` | The Android app: its permissions (`AndroidManifest.xml`), screenshot blocking and the message alert channel (`MainActivity.kt`) |

The app makes no analytics, telemetry or tracking requests, and loads nothing from other companies.

## Good to know

- **Updates are always your choice.** Your build checks ecdh.chat for new versions the same way ours does, and offers one only if it's signed with our release key. Installing it replaces your build with ours. To stay on builds you made yourself, dismiss the offer and build the new version from this repository instead.
- **Builds aren't byte-for-byte identical.** The installers include build timestamps, so their SHA-256 won't match ours even from the same source. Verify by reading and building, not by comparing hashes.
- **Calls aren't in the Linux app yet.** Chats, files and voice messages work as everywhere else.
- **The Android app doesn't update itself.** Get new versions from [ecdh.chat/download](https://ecdh.chat/download). Messages arrive while the app is open; Android pauses apps in the background, and a paused app can't receive.
- **Development builds** (`npm run app:dev`) expect an ecdh.chat signaling server at `http://localhost:3000`, which isn't part of this repository. Use `npm run app:build` to get an app that works with ecdh.chat.

## Security reports

Please email [security@ecdh.chat](mailto:security@ecdh.chat). Include what you found, how to reproduce it, and the app version you tested.

## License

Copyright (C) 2026 god@ecdh.chat

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, version 3. It comes with no warranty. See [LICENSE](LICENSE) for the full text.

`public/vendor/qrcode.mjs` is [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 by Kazuhiko Arase, under the MIT license, unmodified.
