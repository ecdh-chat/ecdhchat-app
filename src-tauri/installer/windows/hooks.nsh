; Extra steps for the ecdh.chat installer, run by Tauri's NSIS template.

!macro NSIS_HOOK_PREUNINSTALL
  ; "Start with Windows" adds this entry for the person who turned it on. The app's name for it
  ; is STARTUP_ENTRY in src-tauri/src/lib.rs.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ecdh.chat"
!macroend
