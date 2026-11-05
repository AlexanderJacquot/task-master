//! `task-master-server`: runs the sync server, or manages its tokens (docs/server.md).

use std::process::ExitCode;

use taskmaster_server::auth::{Scope, Tokens};
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, TOKENS_FILE, backup, serve};

const USAGE: &str = "usage:
  task-master-server [serve]                      run the server
  task-master-server health                       exit 0 when the local server answers
  task-master-server token add <name> [--scope sync|api:read|api:write]
  task-master-server token list
  task-master-server token revoke <name>
  task-master-server version

Configuration comes from TM_* environment variables (docs/server.md).";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => return fail(&e),
    };
    let result = match args.as_slice() {
        [] | ["serve"] => run(config),
        ["health"] => health(&config),
        ["token", rest @ ..] => token(&config, rest),
        ["version" | "--version" | "-V"] => {
            println!("task-master-server {}", taskmaster_core::VERSION);
            Ok(())
        }
        ["help" | "--help" | "-h"] => {
            println!("{USAGE}");
            Ok(())
        }
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => fail(&e),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{message}");
    ExitCode::FAILURE
}

fn run(config: Config) -> Result<(), String> {
    let state = AppState::open(config)?;
    backup::spawn(state.clone());
    tokio::runtime::Runtime::new()
        .map_err(|e| e.to_string())?
        .block_on(serve(state))
}

/// Asks the server on this machine for `/health` (the container image has no curl).
fn health(config: &Config) -> Result<(), String> {
    let port = config.listen.rsplit(':').next().unwrap_or("8080");
    let url = format!("http://127.0.0.1:{port}/health");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(5)))
        .build()
        .into();
    agent
        .get(&url)
        .call()
        .map(|_| ())
        .map_err(|e| format!("{url}: {e}"))
}

fn token(config: &Config, args: &[&str]) -> Result<(), String> {
    std::fs::create_dir_all(&config.data_dir).map_err(|e| e.to_string())?;
    let tokens = Tokens::open(&config.data_dir.join(TOKENS_FILE)).map_err(|e| e.to_string())?;
    match args {
        ["add", name, rest @ ..] => {
            let scope = match rest {
                [] => Scope::Sync,
                ["--scope", s] => Scope::parse(s)
                    .ok_or_else(|| format!("unknown scope '{s}': sync, api:read or api:write"))?,
                _ => return Err(USAGE.to_owned()),
            };
            let token = tokens.add(name, scope)?;
            println!("{token}");
            eprintln!(
                "token '{}' ({}) created; it is shown only once",
                name.trim(),
                scope.as_str()
            );
            Ok(())
        }
        ["list"] => {
            let list = tokens.list()?;
            if list.is_empty() {
                println!("no tokens");
            }
            for t in list {
                let used = t.last_used_at.map_or_else(
                    || "never used".to_owned(),
                    |ms| format!("last used {}", taskmaster_core::utc_date(ms)),
                );
                println!(
                    "{}\t{}\tcreated {}\t{used}",
                    t.name,
                    t.scope,
                    taskmaster_core::utc_date(t.created_at)
                );
            }
            Ok(())
        }
        ["revoke", name] => {
            if tokens.revoke(name)? {
                println!("revoked '{}'", name.trim());
                Ok(())
            } else {
                Err(format!("no token named '{}'", name.trim()))
            }
        }
        _ => Err(USAGE.to_owned()),
    }
}
