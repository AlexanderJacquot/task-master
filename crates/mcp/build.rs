// Windows: version information in task-master-mcp.exe (product name and version), as the
// app's own executable has from tauri-build. Releases sign both with SignPath, whose
// signing policy only accepts files that carry these values (ADR 036).
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows") {
        let mut res = tauri_winres::WindowsResource::new();
        res.set("ProductName", "task-master");
        res.set("FileDescription", "task-master MCP server");
        res.compile().expect("Windows version resource");
    }
}
