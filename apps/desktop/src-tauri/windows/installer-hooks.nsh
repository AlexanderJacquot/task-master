; NSIS hooks for the Windows installer and in-app updates (tauri.sidecar.conf.json).
;
; Claude Code keeps task-master-mcp.exe running for as long as a session that uses it is
; open, and Windows cannot replace a running executable: updates left the old MCP server
; in place (0.20.0 and 0.21.0 shipped new tools that never reached the device). Stop it
; before the files are copied; Claude Code starts the new one on its next connection.
!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'taskkill /F /T /IM task-master-mcp.exe'
  Pop $0
  Sleep 300
!macroend
