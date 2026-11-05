//! Who may call the server: bearer tokens made on the server (stored hashed in
//! `server.sqlite`), and OpenID Connect sign-in that trades a provider's ID token for one.

use std::fmt::Write as _;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use taskmaster_core::now_ms;

/// What a token may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Scope {
    /// Devices: push, pull, events, attachment content.
    Sync,
    /// Read the API (M14).
    ApiRead,
    /// Read and write the API (M14).
    ApiWrite,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sync => "sync",
            Self::ApiRead => "api:read",
            Self::ApiWrite => "api:write",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "sync" => Self::Sync,
            "api:read" => Self::ApiRead,
            "api:write" => Self::ApiWrite,
            _ => return None,
        })
    }

    /// Whether a token with this scope may do what `needed` covers.
    pub fn allows(self, needed: Self) -> bool {
        self == needed || (self == Self::ApiWrite && needed == Self::ApiRead)
    }
}

/// A token as `token list` shows it (never the token itself).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TokenInfo {
    pub name: String,
    pub scope: String,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// The token table, in `<data>/server.sqlite` (separate from the replicated data).
pub struct Tokens {
    conn: Mutex<Connection>,
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .fold(String::with_capacity(64), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

impl Tokens {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS tokens (
               name TEXT PRIMARY KEY,
               hash TEXT NOT NULL UNIQUE,
               scope TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               last_used_at INTEGER
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Makes a token named `name` (replacing one with that name). The token is returned
    /// once; only its hash is kept.
    pub fn add(&self, name: &str, scope: Scope) -> Result<String, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a token needs a name".into());
        }
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| format!("no randomness: {e}"))?;
        let token = bytes.iter().fold(String::from("tm_"), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        });
        self.conn()
            .execute(
                "INSERT INTO tokens (name, hash, scope, created_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (name) DO UPDATE SET hash = excluded.hash, scope = excluded.scope,
                   created_at = excluded.created_at, last_used_at = NULL",
                rusqlite::params![name, sha256_hex(&token), scope.as_str(), now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(token)
    }

    pub fn list(&self) -> Result<Vec<TokenInfo>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT name, scope, created_at, last_used_at FROM tokens ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(TokenInfo {
                    name: r.get(0)?,
                    scope: r.get(1)?,
                    created_at: r.get(2)?,
                    last_used_at: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())
    }

    /// Whether a token with that name existed.
    pub fn revoke(&self, name: &str) -> Result<bool, String> {
        self.conn()
            .execute("DELETE FROM tokens WHERE name = ?1", [name.trim()])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    /// The scope of a valid token (and records its use).
    pub fn check(&self, token: &str) -> Option<Scope> {
        let conn = self.conn();
        let hash = sha256_hex(token);
        let scope: Option<String> = conn
            .query_row("SELECT scope FROM tokens WHERE hash = ?1", [&hash], |r| {
                r.get(0)
            })
            .optional()
            .ok()
            .flatten();
        let scope = Scope::parse(&scope?)?;
        let _ = conn.execute(
            "UPDATE tokens SET last_used_at = ?1 WHERE hash = ?2",
            rusqlite::params![now_ms(), hash],
        );
        Some(scope)
    }
}

/// Claims read from an ID token.
#[derive(Debug, Clone, Deserialize)]
pub struct Claims {
    pub sub: String,
    #[serde(default)]
    pub preferred_username: Option<String>,
    #[serde(default)]
    pub groups: Vec<String>,
}

/// Checks ID tokens from one OpenID provider: signature (keys from its discovery
/// document), issuer, audience and expiry, then the allowed groups.
pub struct Oidc {
    issuer: String,
    client_id: String,
    allowed_groups: Vec<String>,
    keys: Mutex<Option<(JwkSet, Instant)>>,
    agent: ureq::Agent,
}

/// Asymmetric algorithms only: an HMAC token signed with a public key must never pass.
const ALGORITHMS: &[Algorithm] = &[
    Algorithm::RS256,
    Algorithm::RS384,
    Algorithm::RS512,
    Algorithm::PS256,
    Algorithm::PS384,
    Algorithm::PS512,
    Algorithm::ES256,
    Algorithm::ES384,
    Algorithm::EdDSA,
];

/// Refetch the provider's keys at most this often when a token names an unknown key.
const KEY_REFRESH: Duration = Duration::from_secs(60);

impl Oidc {
    pub fn new(issuer: &str, client_id: &str, allowed_groups: Vec<String>) -> Self {
        Self {
            issuer: issuer.trim_end_matches('/').to_owned(),
            client_id: client_id.to_owned(),
            allowed_groups,
            keys: Mutex::new(None),
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(15)))
                .build()
                .into(),
        }
    }

    fn get_json(&self, url: &str) -> Result<serde_json::Value, String> {
        let mut resp = self
            .agent
            .get(url)
            .call()
            .map_err(|e| format!("cannot read {url}: {e}"))?;
        let text = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| format!("cannot read {url}: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("{url} is not JSON: {e}"))
    }

    fn fetch_keys(&self) -> Result<JwkSet, String> {
        let discovery =
            self.get_json(&format!("{}/.well-known/openid-configuration", self.issuer))?;
        let jwks_uri = discovery
            .get("jwks_uri")
            .and_then(|u| u.as_str())
            .ok_or("the provider's discovery document has no jwks_uri")?;
        serde_json::from_value(self.get_json(jwks_uri)?)
            .map_err(|e| format!("the provider's keys are unreadable: {e}"))
    }

    /// The key for `kid`, fetching (or refreshing) the provider's key set when needed.
    fn key(&self, kid: Option<&str>) -> Result<jsonwebtoken::jwk::Jwk, String> {
        let mut cache = self.keys.lock().unwrap_or_else(PoisonError::into_inner);
        let find = |set: &JwkSet| match kid {
            Some(kid) => set.find(kid).cloned(),
            None if set.keys.len() == 1 => set.keys.first().cloned(),
            None => None,
        };
        if let Some((set, _)) = cache.as_ref()
            && let Some(key) = find(set)
        {
            return Ok(key);
        }
        let stale = cache
            .as_ref()
            .is_none_or(|(_, at)| at.elapsed() >= KEY_REFRESH);
        if stale {
            *cache = Some((self.fetch_keys()?, Instant::now()));
        }
        cache
            .as_ref()
            .and_then(|(set, _)| find(set))
            .ok_or_else(|| "the token is signed with a key the provider does not list".into())
    }

    /// Verifies an ID token. Blocking (it may fetch the provider's keys).
    pub fn verify(&self, id_token: &str) -> Result<Claims, String> {
        let header =
            jsonwebtoken::decode_header(id_token).map_err(|e| format!("not a valid token: {e}"))?;
        if !ALGORITHMS.contains(&header.alg) {
            return Err(format!(
                "tokens signed with {:?} are not accepted",
                header.alg
            ));
        }
        let jwk = self.key(header.kid.as_deref())?;
        let key = DecodingKey::from_jwk(&jwk).map_err(|e| format!("unusable key: {e}"))?;
        let mut validation = Validation::new(header.alg);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.client_id]);
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        let claims = jsonwebtoken::decode::<Claims>(id_token, &key, &validation)
            .map_err(|e| format!("sign-in refused: {e}"))?
            .claims;
        if !self.allowed_groups.is_empty()
            && !claims
                .groups
                .iter()
                .any(|g| self.allowed_groups.contains(g))
        {
            return Err("your account is not in a group allowed on this server".into());
        }
        Ok(claims)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_stored_hashed_and_checked_by_scope() {
        let tokens = Tokens::open_in_memory().unwrap();
        let laptop = tokens.add("laptop", Scope::Sync).unwrap();
        assert!(laptop.starts_with("tm_") && laptop.len() == 67);
        assert_eq!(tokens.check(&laptop), Some(Scope::Sync));
        assert_eq!(tokens.check("tm_nope"), None);

        let stored: String = tokens
            .conn()
            .query_row("SELECT hash FROM tokens", [], |r| r.get(0))
            .unwrap();
        assert_ne!(stored, laptop, "only the hash is kept");

        // Same name: replaced, the old token stops working.
        let again = tokens.add("laptop", Scope::ApiRead).unwrap();
        assert_eq!(tokens.check(&laptop), None);
        assert_eq!(tokens.check(&again), Some(Scope::ApiRead));

        let list = tokens.list().unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].last_used_at.is_some());
        assert!(tokens.revoke("laptop").unwrap());
        assert!(!tokens.revoke("laptop").unwrap());
        assert_eq!(tokens.check(&again), None);
        assert!(tokens.add("  ", Scope::Sync).is_err());
    }

    #[test]
    fn scopes() {
        assert!(Scope::ApiWrite.allows(Scope::ApiRead));
        assert!(!Scope::ApiRead.allows(Scope::ApiWrite));
        assert!(!Scope::ApiWrite.allows(Scope::Sync));
        assert!(!Scope::Sync.allows(Scope::ApiRead));
        for s in [Scope::Sync, Scope::ApiRead, Scope::ApiWrite] {
            assert_eq!(Scope::parse(s.as_str()), Some(s));
        }
    }
}
