//! Configuration from environment variables (docs/server.md, section 5).

use std::path::PathBuf;

use taskmaster_core::AuthMode;

/// Where the nightly backup goes (an S3-compatible bucket, e.g. Garage).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3Backup {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub prefix: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub listen: String,
    pub data_dir: PathBuf,
    pub public_url: Option<String>,
    pub auth: AuthMode,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: String,
    pub oidc_allowed_groups: Vec<String>,
    pub backup: Option<S3Backup>,
    pub backup_keep_days: usize,
    /// Serve the remote MCP endpoint `/mcp` (ADR 024).
    pub mcp: bool,
    /// OAuth clients whose access tokens `/mcp` accepts (`client_id` claim).
    pub mcp_oauth_clients: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:8080".into(),
            data_dir: PathBuf::from("/data"),
            public_url: None,
            auth: AuthMode::None,
            oidc_issuer: None,
            oidc_client_id: "task-master".into(),
            oidc_allowed_groups: Vec::new(),
            backup: None,
            backup_keep_days: 30,
            mcp: false,
            mcp_oauth_clients: vec!["task-master-claude".into()],
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_vars(|key| std::env::var(key).ok())
    }

    /// Reads `TM_*` variables through `get` (empty values count as unset).
    pub fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let var = |key: &str| {
            get(key)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let defaults = Self::default();
        let auth = match var("TM_AUTH").as_deref() {
            None | Some("none") => AuthMode::None,
            Some("token") => AuthMode::Token,
            Some("oidc") => AuthMode::Oidc,
            Some(other) => {
                return Err(format!(
                    "TM_AUTH must be none, token or oidc, not '{other}'"
                ));
            }
        };
        let oidc_issuer = var("TM_OIDC_ISSUER").map(|i| i.trim_end_matches('/').to_owned());
        if auth == AuthMode::Oidc && oidc_issuer.is_none() {
            return Err("TM_AUTH=oidc needs TM_OIDC_ISSUER".into());
        }
        let backup = match var("TM_BACKUP_S3_ENDPOINT") {
            None => None,
            Some(endpoint) => {
                let need = |key: &str| {
                    var(key).ok_or_else(|| format!("{key} is required with TM_BACKUP_S3_ENDPOINT"))
                };
                Some(S3Backup {
                    endpoint: endpoint.trim_end_matches('/').to_owned(),
                    region: var("TM_BACKUP_S3_REGION").unwrap_or_else(|| "garage".into()),
                    bucket: need("TM_BACKUP_S3_BUCKET")?,
                    access_key: need("TM_BACKUP_S3_ACCESS_KEY_ID")?,
                    secret_key: need("TM_BACKUP_S3_SECRET_ACCESS_KEY")?,
                    prefix: var("TM_BACKUP_S3_PREFIX")
                        .map(|p| p.trim_matches('/').to_owned())
                        .unwrap_or_default(),
                })
            }
        };
        let backup_keep_days = match var("TM_BACKUP_KEEP_DAYS") {
            None => defaults.backup_keep_days,
            Some(n) => n.parse().ok().filter(|n| *n > 0).ok_or_else(|| {
                format!("TM_BACKUP_KEEP_DAYS must be a positive number, not '{n}'")
            })?,
        };
        let list = |key: &str| {
            var(key).map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
        };
        let public_url = var("TM_PUBLIC_URL").map(|u| u.trim_end_matches('/').to_owned());
        let mcp = match var("TM_MCP").as_deref() {
            None | Some("off") => false,
            Some("on") => true,
            Some(other) => return Err(format!("TM_MCP must be on or off, not '{other}'")),
        };
        if mcp && auth == AuthMode::Oidc && public_url.is_none() {
            return Err(
                "TM_MCP=on with TM_AUTH=oidc needs TM_PUBLIC_URL (the MCP URL Claude uses)".into(),
            );
        }
        let mcp_oauth_clients = list("TM_MCP_OAUTH_CLIENTS")
            .filter(|c| !c.is_empty())
            .unwrap_or(defaults.mcp_oauth_clients);
        Ok(Self {
            listen: var("TM_LISTEN").unwrap_or(defaults.listen),
            data_dir: var("TM_DATA_DIR").map_or(defaults.data_dir, PathBuf::from),
            public_url,
            auth,
            oidc_issuer,
            oidc_client_id: var("TM_OIDC_CLIENT_ID").unwrap_or(defaults.oidc_client_id),
            oidc_allowed_groups: list("TM_OIDC_ALLOWED_GROUPS").unwrap_or_default(),
            backup,
            backup_keep_days,
            mcp,
            mcp_oauth_clients,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: std::collections::HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn defaults_need_nothing() {
        assert_eq!(Config::from_vars(vars(&[])).unwrap(), Config::default());
    }

    #[test]
    fn full_homelab_config() {
        let c = Config::from_vars(vars(&[
            ("TM_LISTEN", "0.0.0.0:8080"),
            ("TM_DATA_DIR", "/srv/tm"),
            ("TM_PUBLIC_URL", "https://tasks.example.org/"),
            ("TM_AUTH", "oidc"),
            ("TM_OIDC_ISSUER", "https://auth.example.org/"),
            ("TM_OIDC_ALLOWED_GROUPS", "admins, family,"),
            ("TM_BACKUP_S3_ENDPOINT", "http://10.0.0.5:3900"),
            ("TM_BACKUP_S3_BUCKET", "task-master-server"),
            ("TM_BACKUP_S3_ACCESS_KEY_ID", "GK1"),
            ("TM_BACKUP_S3_SECRET_ACCESS_KEY", "secret"),
            ("TM_BACKUP_KEEP_DAYS", "7"),
        ]))
        .unwrap();
        assert_eq!(c.auth, AuthMode::Oidc);
        assert_eq!(c.oidc_issuer.as_deref(), Some("https://auth.example.org"));
        assert_eq!(c.public_url.as_deref(), Some("https://tasks.example.org"));
        assert_eq!(c.oidc_allowed_groups, ["admins", "family"]);
        assert_eq!(c.backup.as_ref().unwrap().region, "garage");
        assert_eq!(c.backup_keep_days, 7);
        assert_eq!(c.data_dir, PathBuf::from("/srv/tm"));
        assert!(!c.mcp, "the MCP endpoint is off unless asked for");
    }

    #[test]
    fn remote_mcp() {
        let c = Config::from_vars(vars(&[
            ("TM_AUTH", "oidc"),
            ("TM_OIDC_ISSUER", "https://auth.example.org"),
            ("TM_PUBLIC_URL", "https://tasks.example.org"),
            ("TM_MCP", "on"),
        ]))
        .unwrap();
        assert!(c.mcp);
        assert_eq!(c.mcp_oauth_clients, ["task-master-claude"]);
        let c =
            Config::from_vars(vars(&[("TM_MCP", "on"), ("TM_MCP_OAUTH_CLIENTS", "a, b")])).unwrap();
        assert_eq!(c.mcp_oauth_clients, ["a", "b"]);
    }

    #[test]
    fn mistakes_are_explained() {
        let bad = |pairs: &[(&str, &str)]| Config::from_vars(vars(pairs)).unwrap_err();
        assert!(bad(&[("TM_AUTH", "basic")]).contains("TM_AUTH"));
        assert!(bad(&[("TM_AUTH", "oidc")]).contains("TM_OIDC_ISSUER"));
        assert!(bad(&[("TM_BACKUP_S3_ENDPOINT", "http://x")]).contains("TM_BACKUP_S3_BUCKET"));
        assert!(bad(&[("TM_BACKUP_KEEP_DAYS", "0")]).contains("positive"));
        assert!(bad(&[("TM_MCP", "yes")]).contains("TM_MCP"));
        let no_url = bad(&[
            ("TM_AUTH", "oidc"),
            ("TM_OIDC_ISSUER", "https://auth.example.org"),
            ("TM_MCP", "on"),
        ]);
        assert!(no_url.contains("TM_PUBLIC_URL"));
    }
}
