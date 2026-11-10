//! OpenID Connect sign-in for a task-master server in `oidc` mode (ADR 015):
//! authorization code + PKCE as a public client. The shell owns the redirect: a loopback
//! listener on the desktop (RFC 8252), a custom URL scheme on the phone (ADR 022). The
//! ID token this ends with is traded for a server token by [`crate::Client::oidc_exchange`].

use std::time::Duration;

use serde_json::Value;

use crate::google;

/// A sign-in in progress: open [`Flow::auth_url`], get the `code` the provider sends to
/// the redirect, then [`Flow::finish`].
pub struct Flow {
    /// The provider's sign-in page, to open in a browser.
    pub auth_url: String,
    redirect: String,
    verifier: String,
    state: String,
    token_url: String,
    client_id: String,
    agent: ureq::Agent,
}

/// The provider's sign-in page URL.
pub fn auth_url(
    authorization_endpoint: &str,
    client_id: &str,
    redirect: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(authorization_endpoint)
        .map_err(|e| format!("the provider's sign-in address is invalid: {e}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid profile groups")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.into())
}

fn get_json(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    let mut resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("cannot reach {url}: {e}"))?;
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("{url} did not answer JSON: {e}"))
}

/// Reads the provider's discovery document and prepares a sign-in that comes back to
/// `redirect` (which must be registered with the provider).
pub fn begin(issuer: &str, client_id: &str, redirect: &str) -> Result<Flow, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(30)))
        .http_status_as_error(false)
        .build()
        .into();
    let discovery = get_json(
        &agent,
        &format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        ),
    )?;
    let endpoint = |name: &str| {
        discovery[name]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("the provider's discovery document has no {name}"))
    };
    let (authorize, token_url) = (
        endpoint("authorization_endpoint")?,
        endpoint("token_endpoint")?,
    );
    let verifier = google::random_token(48)?;
    let state = google::random_token(16)?;
    Ok(Flow {
        auth_url: auth_url(
            &authorize,
            client_id,
            redirect,
            &google::challenge(&verifier),
            &state,
        )?,
        redirect: redirect.to_owned(),
        verifier,
        state,
        token_url,
        client_id: client_id.to_owned(),
        agent,
    })
}

impl Flow {
    /// The `state` the redirect must carry back.
    pub fn state(&self) -> &str {
        &self.state
    }

    /// The `code` in the URL the provider redirected to, for shells that receive the
    /// whole URL (a custom scheme). Checks `state` and reports the provider's error.
    pub fn code_from_redirect(&self, url: &str) -> Result<String, String> {
        let url =
            url::Url::parse(url).map_err(|e| format!("the sign-in came back unreadable: {e}"))?;
        let get = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        if let Some(error) = get("error") {
            let detail = get("error_description").unwrap_or(error);
            return Err(format!("the provider refused the sign-in: {detail}"));
        }
        if get("state").as_deref() != Some(self.state.as_str()) {
            return Err("the sign-in answer does not belong to this attempt".into());
        }
        get("code").ok_or_else(|| "the provider sent no code".into())
    }

    /// Trades the code for the provider's ID token.
    pub fn finish(&self, code: &str) -> Result<String, String> {
        let mut resp = self
            .agent
            .post(&self.token_url)
            .send_form([
                ("grant_type", "authorization_code"),
                ("code", code),
                ("client_id", self.client_id.as_str()),
                ("redirect_uri", self.redirect.as_str()),
                ("code_verifier", self.verifier.as_str()),
            ])
            .map_err(|e| format!("cannot reach the provider: {e}"))?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .read_to_string()
            .map_err(|e| e.to_string())?;
        let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status != 200 {
            let mut message = format!("the provider refused the sign-in (HTTP {status})");
            if let Some(e) = body["error_description"]
                .as_str()
                .or(body["error"].as_str())
            {
                message.push_str(": ");
                message.push_str(e);
            }
            return Err(message);
        }
        body["id_token"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "the provider sent no ID token (is the `openid` scope allowed?)".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow() -> Flow {
        Flow {
            auth_url: String::new(),
            redirect: "taskmaster://oidc/callback".into(),
            verifier: "v".into(),
            state: "st".into(),
            token_url: String::new(),
            client_id: "task-master".into(),
            agent: ureq::Agent::new_with_defaults(),
        }
    }

    #[test]
    fn sign_in_url_uses_pkce_and_the_given_redirect() {
        let url = auth_url(
            "https://auth.example.org/api/oidc/authorization",
            "task-master",
            "http://127.0.0.1:47823/oidc/callback",
            "chal",
            "st",
        )
        .unwrap();
        let url = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "task-master");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:47823/oidc/callback");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["code_challenge_method"], "S256");
        assert!(q["scope"].split(' ').any(|s| s == "openid"));
        assert_eq!(url.path(), "/api/oidc/authorization");
    }

    #[test]
    fn the_code_is_read_from_a_custom_scheme_redirect() {
        let flow = flow();
        assert_eq!(
            flow.code_from_redirect("taskmaster://oidc/callback?code=abc&state=st"),
            Ok("abc".into())
        );
        let stale = flow.code_from_redirect("taskmaster://oidc/callback?code=abc&state=other");
        assert!(stale.unwrap_err().contains("does not belong"));
        let denied = flow.code_from_redirect(
            "taskmaster://oidc/callback?error=access_denied&error_description=No+access&state=st",
        );
        assert!(denied.unwrap_err().contains("No access"));
        assert!(
            flow.code_from_redirect("taskmaster://oidc/callback?state=st")
                .is_err()
        );
    }
}
