//! `task-master-server`: runs the sync server, or manages its tokens (docs/server.md).

use std::process::ExitCode;

use taskmaster_server::auth::{Scope, Tokens};
use taskmaster_server::config::Config;
use taskmaster_server::{AppState, TOKENS_FILE, backup, serve};

const USAGE: &str = "usage:
  task-master-server [serve]                      run the server
  task-master-server health                       exit 0 when the local server answers
  task-master-server token add <name> [--scope sync|api:read|api:write] [--user <user>]
  task-master-server token list
  task-master-server token revoke <name>
  task-master-server user add <name>              a team member (TM_TEAM=on)
  task-master-server user list
  task-master-server user rename <user> <name>
  task-master-server user remove <user>           leaves the team; their tokens are revoked
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
        ["user", rest @ ..] => user(&config, rest),
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
            let mut scope = Scope::Sync;
            let mut user = None;
            let mut rest = rest;
            while let [flag, value, more @ ..] = rest {
                match *flag {
                    "--scope" => {
                        scope = Scope::parse(value).ok_or_else(|| {
                            format!("unknown scope '{value}': sync, api:read or api:write")
                        })?;
                    }
                    "--user" => {
                        let found = tokens
                            .find_user(value)?
                            .filter(|u| u.removed_at.is_none())
                            .ok_or_else(|| format!("no user '{value}' (user add <name>)"))?;
                        user = Some(found);
                    }
                    _ => return Err(USAGE.to_owned()),
                }
                rest = more;
            }
            if !rest.is_empty() {
                return Err(USAGE.to_owned());
            }
            let token = tokens.add_for(name, scope, user.as_ref().map(|u| u.id.as_str()))?;
            println!("{token}");
            let owner = user.map(|u| format!(" for {}", u.name)).unwrap_or_default();
            eprintln!(
                "token '{}' ({}){owner} created; it is shown only once",
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
                let user = t.user.map(|u| format!("\tuser {u}")).unwrap_or_default();
                println!(
                    "{}\t{}\tcreated {}\t{used}{user}",
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

/// Team members (ADR 033). The running server writes them into the team space at its next
/// team request.
fn user(config: &Config, args: &[&str]) -> Result<(), String> {
    std::fs::create_dir_all(&config.data_dir).map_err(|e| e.to_string())?;
    let tokens = Tokens::open(&config.data_dir.join(TOKENS_FILE)).map_err(|e| e.to_string())?;
    if !config.team {
        eprintln!("note: TM_TEAM is off; users only matter on a team server");
    }
    let find = |who: &str| {
        tokens
            .find_user(who)?
            .filter(|u| u.removed_at.is_none())
            .ok_or_else(|| format!("no user '{who}'"))
    };
    match args {
        ["add", name] => {
            let user = tokens.add_user(name)?;
            println!("{}", user.id);
            eprintln!(
                "user '{}' added; give them a token: token add <device> --user '{}'",
                user.name, user.name
            );
            Ok(())
        }
        ["list"] => {
            let users = tokens.users()?;
            if users.is_empty() {
                println!("no users");
            }
            for u in users {
                let state = u.removed_at.map_or_else(
                    || "member".to_owned(),
                    |ms| format!("removed {}", taskmaster_core::utc_date(ms)),
                );
                println!("{}\t{}\t{state}", u.id, u.name);
            }
            Ok(())
        }
        ["rename", who, name] => {
            let user = tokens.rename_user(&find(who)?.id, name)?;
            println!("renamed to '{}'", user.name);
            Ok(())
        }
        ["remove", who] => {
            let user = find(who)?;
            tokens.remove_user(&user.id)?;
            println!("removed '{}' and revoked their tokens", user.name);
            Ok(())
        }
        _ => Err(USAGE.to_owned()),
    }
}
