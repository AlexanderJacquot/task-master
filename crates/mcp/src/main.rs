//! `task-master-mcp [--db <path>] [--session <id>] [--done-status <status id>]`: the stdio
//! MCP server Claude Code starts for a session (docs/adr/017-agent-sessions.md), or that
//! you add to Claude yourself (docs/mcp.md). Without `--db` it opens this device's
//! database (`locate`). Logs go to stderr; stdout is the protocol.

use rmcp::ServiceExt;
use taskmaster_core::{AgentWorkflow, Store};
use taskmaster_mcp::{TaskServer, locate};

const USAGE: &str = "usage: task-master-mcp [--db <path to task-master.sqlite>] \
                     [--session <session id>] [--done-status <status id>] [--no-edit-user-tasks]\n       \
                     task-master-mcp --show-db\n\n\
                     Without --db: $TASK_MASTER_DB, else the task-master app's database on \
                     this device.\n--show-db prints that path and exits.";

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
    // Where the session's task goes when the agent reports it done (Settings → Agents).
    let mut workflow = AgentWorkflow::default();
    // Settings → Agents: may the agent edit the user's own tasks?
    let mut edit_user_tasks = true;
    let mut show_db = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--db" => db = args.next(),
            "--session" => session = args.next(),
            "--done-status" => workflow.done_status_id = args.next(),
            "--no-edit-user-tasks" => edit_user_tasks = false,
            "--show-db" => show_db = true,
            "--help" | "-h" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => return Err(format!("unknown argument '{other}'\n{USAGE}")),
        }
    }
    let db = match db {
        Some(db) => std::path::PathBuf::from(db),
        None => locate::default_database(|key| std::env::var(key).ok())?,
    };
    if show_db {
        println!("{}", db.display());
        return Ok(());
    }
    // Never create a database: a wrong path must fail, not start an empty one.
    if !db.is_file() {
        return Err(format!(
            "no database at {} (open the task-master app once, or pass --db)",
            db.display()
        ));
    }
    let db = db.display().to_string();
    let store = Store::open(&db).map_err(|e| format!("cannot open {db}: {e}"))?;
    let server = TaskServer::new(store, session.as_deref())
        .map_err(|e| format!("cannot load session: {e}"))?
        .with_workflow(workflow)
        .with_edit_user_tasks(edit_user_tasks);
    let service = server
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|e| format!("cannot start: {e}"))?;
    service.waiting().await.map_err(|e| e.to_string())?;
    Ok(())
}
