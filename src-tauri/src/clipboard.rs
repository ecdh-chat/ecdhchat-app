// Copying text from the chat. On Windows the browser's clipboard puts it into clipboard history
// (Win+V) and, when it's on, the cloud clipboard that syncs to the person's other devices. Here the
// text goes onto the clipboard with the formats Windows reads as "keep this out of history, out of
// the cloud and away from clipboard monitors". Elsewhere the page uses the browser's clipboard.

/// More than any message or invite link; anything longer is refused.
const MAX_TEXT: usize = 1024 * 1024;

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    if text.len() > MAX_TEXT {
        return Err("text too long".into());
    }
    write(&text)
}

#[cfg(windows)]
fn write(text: &str) -> Result<(), String> {
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;

    // Puts bytes on the clipboard as the given format. The clipboard owns the memory afterwards.
    unsafe fn set(format: u32, bytes: &[u8]) -> Result<(), String> {
        unsafe {
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1));
            if memory.is_null() {
                return Err("out of memory".into());
            }
            let target = GlobalLock(memory) as *mut u8;
            if target.is_null() {
                GlobalFree(memory);
                return Err("out of memory".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
            GlobalUnlock(memory);
            if SetClipboardData(format, memory).is_null() {
                GlobalFree(memory);
                return Err("clipboard refused the data".into());
            }
            Ok(())
        }
    }

    fn format(name: &str) -> u32 {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr()) }
    }

    let utf16: Vec<u8> = text.encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect();
    let zero = 0u32.to_le_bytes();

    // Another program may hold the clipboard for a moment.
    let mut opened = false;
    for _ in 0..10 {
        if unsafe { OpenClipboard(null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !opened {
        return Err("clipboard busy".into());
    }

    let result = (|| unsafe {
        if EmptyClipboard() == 0 {
            return Err("clipboard busy".to_string());
        }
        set(CF_UNICODETEXT, &utf16)?;
        set(format("ExcludeClipboardContentFromMonitorProcessing"), &zero)?;
        set(format("CanIncludeInClipboardHistory"), &zero)?;
        set(format("CanUploadToCloudClipboard"), &zero)
    })();
    unsafe { CloseClipboard() };
    result
}

#[cfg(not(windows))]
fn write(_text: &str) -> Result<(), String> {
    Err("not available".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_text_longer_than_any_message() {
        assert_eq!(copy_text("x".repeat(MAX_TEXT + 1)), Err("text too long".into()));
    }
}
