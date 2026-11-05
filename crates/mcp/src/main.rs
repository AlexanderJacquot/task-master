//! `task-master-mcp --db <path> [--session <id>]`: the stdio MCP server Claude Code starts
//! for a session (docs/adr/017-agent-sessions.md). Logs go to stderr; stdout is the
//! protocol.

use rmcp::ServiceExt;
use taskmaster_core::Store;
use taskmaster_mcp::TaskServer;

const USAGE: &str = "usage: task-master-mcp --db <path to tasks.sqlite> [--session <session id>]";

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(message) = run().await {
        eprintln!("task-master-mcp: {message}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let mut db = None;
    let mut session = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = args.next(),
            "--session" => session = args.next(),
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => return Err(format!("unknown argument '{other}'\n{USAGE}")),
        }
    }
    let db = db.ok_or_else(|| USAGE.to_owned())?;
    // Never create a database: a wrong path must fail, not start an empty one.
    if !std::path::Path::new(&db).is_file() {
        return Err(format!("no database at {db}"));
    }
    let store = Store::open(&db).map_err(|e| format!("cannot open {db}: {e}"))?;
    let server = TaskServer::new(store, session.as_deref())
        .map_err(|e| format!("cannot load session: {e}"))?;
    let service = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| format!("cannot start: {e}"))?;
    service.waiting().await.map_err(|e| e.to_string())?;
    Ok(())
}
