#!/usr/bin/env bash
# Simulates a team on one machine (ADR 033): a local sync server with TM_TEAM=on and two
# members, and two desktop apps with their own identifiers, so each has its own config and
# database and neither touches the installed app's.
#
#   scripts/team-sim/run.sh server   build and start the team server (foreground, Ctrl-C stops)
#   scripts/team-sim/run.sh apps     build the two debug app bundles, signed in as Alice and Bob
#   scripts/team-sim/run.sh open     start both apps (their logs go to $TEAM_SIM_DIR)
#   scripts/team-sim/run.sh status   each member's /info and how many ops each space holds
#   scripts/team-sim/run.sh cli …    the server's CLI on the sim data (e.g. cli user remove Bob)
#   scripts/team-sim/run.sh reset    delete the server's data and both apps' config and data
#
# Run `server` in one terminal, then `apps` and `open` in another. Environment:
#   TEAM_SIM_DIR   server data and tokens (default: target/team-sim)
#   TEAM_SIM_PORT  server port (default: 8787)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="${TEAM_SIM_DIR:-$ROOT/target/team-sim}"
PORT="${TEAM_SIM_PORT:-8787}"
URL="http://127.0.0.1:$PORT"
MEMBERS=(Alice Bob)
SERVER="$ROOT/target/debug/task-master-server"

export TM_LISTEN="127.0.0.1:$PORT"
export TM_DATA_DIR="$DIR/server"
export TM_AUTH=token
export TM_TEAM=on
export TM_TEAM_NAME="${TM_TEAM_NAME:-Sim Team}"

lower() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
identifier() { echo "space.solarnexus.taskmaster.teamsim.$(lower "$1")"; }
product() { echo "Task Master $1"; }

config_dir() {
  case "$(uname)" in
    Darwin) echo "$HOME/Library/Application Support/$(identifier "$1")" ;;
    *) echo "${XDG_CONFIG_HOME:-$HOME/.config}/$(identifier "$1")" ;;
  esac
}

data_dir() {
  case "$(uname)" in
    Darwin) config_dir "$1" ;;
    *) echo "${XDG_DATA_HOME:-$HOME/.local/share}/$(identifier "$1")" ;;
  esac
}

build_server() {
  # Outside the dev shell (no cargo) the binary built earlier will do.
  if ! command -v cargo >/dev/null && [[ -x "$SERVER" ]]; then
    return
  fi
  cargo build --manifest-path "$ROOT/Cargo.toml" -p taskmaster-server --quiet
}

# One user and one sync token per member, made once; the tokens are kept in $DIR.
ensure_members() {
  mkdir -p "$DIR/tokens"
  local name users
  users="$("$SERVER" user list)"
  for name in "${MEMBERS[@]}"; do
    if ! grep -qw "$name" <<<"$users"; then
      "$SERVER" user add "$name" >/dev/null
    fi
    local file="$DIR/tokens/$(lower "$name")"
    if [[ ! -s "$file" ]]; then
      "$SERVER" token add "$(lower "$name")-sim" --user "$name" --scope sync | head -n1 >"$file"
      chmod 600 "$file"
    fi
  done
}

token_of() {
  local file="$DIR/tokens/$(lower "$1")"
  [[ -s "$file" ]] || { echo "no token for $1: run '$0 server' first" >&2; exit 1; }
  cat "$file"
}

# The app's config.json, signed in to the sim server and joined (what the first sync's
# "keep this device's data" choice saves), so the app syncs from its first start.
write_config() {
  local name="$1" dir
  dir="$(config_dir "$name")"
  mkdir -p "$dir"
  if [[ -f "$dir/config.json" ]]; then
    echo "$(product "$name"): keeping $dir/config.json"
    return
  fi
  local token
  token="$(token_of "$name")"
  cat >"$dir/config.json" <<EOF
{
  "sync": {
    "url": "$URL",
    "token": "$token",
    "device_name": "$(lower "$name")-sim",
    "joined": true
  }
}
EOF
  chmod 600 "$dir/config.json"
  echo "$(product "$name"): wrote $dir/config.json"
}

bundle_path() {
  local name="$1" base="$ROOT/target/team-sim/apps/$(lower "$1")"
  case "$(uname)" in
    Darwin) echo "$base/$(product "$name").app" ;;
    *) echo "$base/taskmaster-desktop" ;;
  esac
}

build_app() {
  local name="$1" out
  out="$ROOT/target/team-sim/apps/$(lower "$name")"
  local overrides
  # Its own identifier, so its own config and database; skips `tsc`, which CI runs.
  overrides=$(cat <<EOF
{
  "identifier": "$(identifier "$name")",
  "productName": "$(product "$name")",
  "build": { "beforeBuildCommand": "pnpm exec vite build" }
}
EOF
)
  echo "Building $(product "$name")…"
  (
    cd "$ROOT/apps/desktop"
    case "$(uname)" in
      Darwin) pnpm tauri build --debug --bundles app --config "$overrides" ;;
      *) pnpm tauri build --debug --no-bundle --config "$overrides" ;;
    esac
  )
  rm -rf "$out"
  mkdir -p "$out"
  case "$(uname)" in
    Darwin) cp -R "$ROOT/target/debug/bundle/macos/$(product "$name").app" "$out/" ;;
    *) cp "$ROOT/target/debug/taskmaster-desktop" "$out/" ;;
  esac
  echo "$(product "$name"): $(bundle_path "$name")"
}

cmd_server() {
  build_server
  ensure_members
  echo "Team server '$TM_TEAM_NAME' on $URL, data in $TM_DATA_DIR"
  echo "Members: ${MEMBERS[*]} (tokens in $DIR/tokens)"
  exec "$SERVER" serve
}

cmd_apps() {
  [[ -d "$ROOT/node_modules" ]] || (cd "$ROOT" && pnpm install --frozen-lockfile)
  local name
  for name in "${MEMBERS[@]}"; do
    write_config "$name"
    build_app "$name"
  done
}

cmd_open() {
  local name path
  for name in "${MEMBERS[@]}"; do
    path="$(bundle_path "$name")"
    [[ -e "$path" ]] || { echo "missing $path: run '$0 apps' first" >&2; exit 1; }
    write_config "$name"
    # The binary itself: `open -n` on a freshly built ad-hoc bundle can return without
    # starting it.
    [[ "$(uname)" == Darwin ]] && path="$path/Contents/MacOS/taskmaster-desktop"
    nohup "$path" >"$DIR/$(lower "$name").log" 2>&1 &
    echo "$(product "$name") started (log: $DIR/$(lower "$name").log)"
  done
}

cmd_status() {
  curl -fsS "$URL/health" >/dev/null || { echo "server not running on $URL" >&2; exit 1; }
  local name token
  for name in "${MEMBERS[@]}"; do
    token="$(token_of "$name")"
    echo "== $name"
    curl -fsS -H "Authorization: Bearer $token" "$URL/info"
    echo
    echo "personal ops: $(head_of "$token" "")   team ops: $(head_of "$token" /team)"
  done
}

# The newest op's sequence number in a space ("" or "/team"): how many ops it holds.
head_of() {
  curl -fsS -H "Authorization: Bearer $1" "$URL$2/sync/pull?after=0&limit=1" \
    | sed -E 's/.*"head":([0-9-]+).*/\1/'
}

cmd_reset() {
  local name
  if curl -fsS "$URL/health" >/dev/null 2>&1; then
    echo "stop the server first" >&2
    exit 1
  fi
  rm -rf "$DIR/server" "$DIR/tokens"
  for name in "${MEMBERS[@]}"; do
    rm -rf "$(config_dir "$name")" "$(data_dir "$name")"
  done
  echo "reset: server data, tokens and both apps' config and data deleted"
}

case "${1:-}" in
  server) cmd_server ;;
  apps) cmd_apps ;;
  open) cmd_open ;;
  status) cmd_status ;;
  cli)
    shift
    exec "$SERVER" "$@"
    ;;
  reset) cmd_reset ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
