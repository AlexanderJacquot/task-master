//! Google Calendar (M10, ADR 014): OAuth 2.0 for installed apps (loopback redirect with
//! PKCE) and the Calendar v3 REST calls behind `taskmaster_core::calendar::CalendarProvider`.
//!
//! The user brings their own OAuth client (a "Desktop app" client of their Google Cloud
//! project). Google treats its secret as not confidential for installed apps; it is kept
//! in `config.json` with the refresh token.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use taskmaster_core::calendar::{
    CalendarProvider, ChangeSet, EventBody, ProviderError, ProviderResult, RemoteCalendar,
    RemoteEvent, When, format_utc, parse_rfc3339,
};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API: &str = "https://www.googleapis.com/calendar/v3";
/// Least privilege: manage only calendars the app creates; read the others.
pub const SCOPES: &str = "https://www.googleapis.com/auth/calendar.app.created \
    https://www.googleapis.com/auth/calendar.calendarlist.readonly \
    https://www.googleapis.com/auth/calendar.events.readonly";
/// How long the browser sign-in may take.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// The private event property naming the local item an event was pushed from.
const KEY_PROPERTY: &str = "taskMasterKey";

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_global(Some(Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into()
}

pub fn random_token(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("no secure random source: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// PKCE S256: the challenge sent with the sign-in for a secret `verifier`.
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// The sign-in page URL.
pub fn auth_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> String {
    let mut url = url::Url::parse(AUTH_URL).expect("static URL");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        // A refresh token, every time (also after a disconnect).
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.into()
}

/// What the browser brought back to the loopback address.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code(String),
    Denied(String),
    /// Something else asked for (a favicon): keep waiting.
    Other,
}

/// Reads `GET /?code=..&state=..` (or `error=..`) from the redirect's request line.
pub fn parse_callback(request_line: &str, state: &str) -> Result<Callback, String> {
    // Browsers also open idle "preconnect" sockets: an empty or odd request is ignored.
    let Some(path) = request_line.split_whitespace().nth(1) else {
        return Ok(Callback::Other);
    };
    let Ok(url) = url::Url::parse(&format!("http://127.0.0.1{path}")) else {
        return Ok(Callback::Other);
    };
    let get = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    if let Some(error) = get("error") {
        return Ok(Callback::Denied(error));
    }
    let Some(code) = get("code") else {
        return Ok(Callback::Other);
    };
    if get("state").as_deref() != Some(state) {
        return Err("the sign-in answer did not match this request".into());
    }
    Ok(Callback::Code(code))
}

/// The page the browser shows after the redirect. `provider` names what was signed in to.
fn answer(mut stream: &TcpStream, ok: bool, provider: &str) {
    let body = if ok {
        format!(
            "<!doctype html><meta charset=utf-8><title>task-master</title>\
             <body style=\"font:16px system-ui;padding:3em\"><h1>Connected</h1>\
             <p>task-master is now connected to {provider}. You can close this tab.</p>"
        )
    } else {
        "<!doctype html><meta charset=utf-8><title>task-master</title>\
         <body style=\"font:16px system-ui;padding:3em\"><h1>Not connected</h1>\
         <p>Go back to task-master to try again.</p>"
            .to_owned()
    };
    let _ = write!(
        stream,
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\
         connection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Signs in through the browser and returns a refresh token. `open` shows the sign-in
/// page (the default browser).
pub fn sign_in(
    client_id: &str,
    client_secret: &str,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let redirect = format!(
        "http://127.0.0.1:{}",
        listener.local_addr().map_err(|e| e.to_string())?.port()
    );
    let verifier = random_token(48)?;
    let state = random_token(16)?;
    open(&auth_url(
        client_id,
        &redirect,
        &challenge(&verifier),
        &state,
    ))?;

    let code = receive_code(
        &listener,
        &state,
        Instant::now() + SIGN_IN_TIMEOUT,
        "Google Calendar",
    )?;

    let token = post_token(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", &redirect),
        ("code_verifier", &verifier),
    ])?;
    token["refresh_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "Google sent no refresh token; try connecting again".into())
}

/// Waits on the loopback listener for the browser's redirect and returns its code.
/// Other requests (a favicon) are answered and ignored.
pub fn receive_code(
    listener: &TcpListener,
    state: &str,
    deadline: Instant,
    provider: &str,
) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    loop {
        if Instant::now() > deadline {
            return Err(format!("the sign-in to {provider} timed out"));
        }
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let mut line = String::new();
        let _ = BufReader::new(&stream).read_line(&mut line);
        match parse_callback(&line, state) {
            Ok(Callback::Code(code)) => {
                answer(&stream, true, provider);
                return Ok(code);
            }
            Ok(Callback::Denied(why)) => {
                answer(&stream, false, provider);
                return Err(format!("sign-in to {provider} refused: {why}"));
            }
            Ok(Callback::Other) => answer(&stream, false, provider),
            Err(e) => {
                answer(&stream, false, provider);
                return Err(e);
            }
        }
    }
}

fn post_token(form: &[(&str, &str)]) -> Result<Value, String> {
    let mut response = agent()
        .post(TOKEN_URL)
        .send_form(form.iter().copied())
        .map_err(|e| format!("could not reach Google: {e}"))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status != 200 {
        let error = body["error"].as_str().unwrap_or("error");
        let detail = body["error_description"].as_str().unwrap_or("");
        return Err(format!("{error}: {detail} (HTTP {status})"));
    }
    Ok(body)
}

/// Asks Google to forget a token (disconnecting). Best effort: the token is dropped here
/// either way.
pub fn revoke(token: &str) {
    if let Err(e) = agent()
        .post("https://oauth2.googleapis.com/revoke")
        .send_form([("token", token)])
    {
        eprintln!("could not revoke the Google token: {e}");
    }
}

/// A signed-in account.
pub struct GoogleCalendar {
    agent: ureq::Agent,
    client_id: String,
    client_secret: String,
    refresh_token: String,
    access: Option<(String, Instant)>,
    guard: Option<Box<dyn Fn() -> ProviderResult<()> + Send>>,
}

impl GoogleCalendar {
    pub fn new(client_id: &str, client_secret: &str, refresh_token: &str) -> Self {
        Self {
            agent: agent(),
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            refresh_token: refresh_token.into(),
            access: None,
            guard: None,
        }
    }

    /// Checks exclusive runner ownership before every Google request.
    pub fn set_guard(&mut self, guard: impl Fn() -> ProviderResult<()> + Send + 'static) {
        self.guard = Some(Box::new(guard));
    }

    fn access_token(&mut self) -> ProviderResult<String> {
        if let Some((token, until)) = &self.access
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let body = post_token(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", &self.refresh_token),
            ("client_id", &self.client_id),
            ("client_secret", &self.client_secret),
        ])
        .map_err(|e| {
            if e.starts_with("invalid_grant") || e.starts_with("invalid_client") {
                ProviderError::Auth(e)
            } else {
                ProviderError::Other(e)
            }
        })?;
        let token = body["access_token"]
            .as_str()
            .ok_or_else(|| ProviderError::Other("no access token in Google's answer".into()))?
            .to_owned();
        let seconds = body["expires_in"].as_u64().unwrap_or(3600);
        // Renew a minute early.
        let until = Instant::now() + Duration::from_secs(seconds.saturating_sub(60));
        self.access = Some((token.clone(), until));
        Ok(token)
    }

    /// One API call; a 401 renews the access token once.
    fn call(
        &mut self,
        method: &str,
        url: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> ProviderResult<Value> {
        for attempt in 0..2 {
            if let Some(guard) = &self.guard {
                guard()?;
            }
            let token = self.access_token()?;
            let auth = format!("Bearer {token}");
            let pairs = query.iter().map(|(k, v)| (*k, v.as_str()));
            let result = match method {
                "GET" => self
                    .agent
                    .get(url)
                    .header("authorization", &auth)
                    .query_pairs(pairs)
                    .call(),
                "DELETE" => self
                    .agent
                    .delete(url)
                    .header("authorization", &auth)
                    .query_pairs(pairs)
                    .call(),
                _ => {
                    let request = if method == "PUT" {
                        self.agent.put(url)
                    } else {
                        self.agent.post(url)
                    };
                    request
                        .header("authorization", &auth)
                        .header("content-type", "application/json")
                        .query_pairs(pairs)
                        .send(body.map(Value::to_string).unwrap_or_default())
                }
            };
            let mut response =
                result.map_err(|e| ProviderError::Other(format!("could not reach Google: {e}")))?;
            let status = response.status().as_u16();
            let text = response.body_mut().read_to_string().unwrap_or_default();
            let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            match status {
                200..=299 => return Ok(json),
                401 if attempt == 0 => self.access = None,
                401 => return Err(ProviderError::Auth("Google refused the sign-in".into())),
                404 => return Err(ProviderError::NotFound),
                410 if method == "DELETE" => return Err(ProviderError::NotFound),
                410 => return Err(ProviderError::TokenExpired),
                _ => {
                    let message = json["error"]["message"].as_str().unwrap_or("error");
                    return Err(ProviderError::Other(format!(
                        "Google Calendar: {message} (HTTP {status})"
                    )));
                }
            }
        }
        unreachable!("the loop returns on its second attempt")
    }

    /// Every page of a listing.
    fn list(&mut self, url: &str, query: &[(&str, String)]) -> ProviderResult<(Vec<Value>, Value)> {
        let mut items = Vec::new();
        let mut page: Option<String> = None;
        loop {
            let mut q = query.to_vec();
            if let Some(token) = &page {
                q.push(("pageToken", token.clone()));
            }
            let json = self.call("GET", url, &q, None)?;
            if let Some(list) = json["items"].as_array() {
                items.extend(list.iter().cloned());
            }
            match json["nextPageToken"].as_str() {
                Some(next) => page = Some(next.to_owned()),
                None => return Ok((items, json)),
            }
        }
    }
}

fn calendar_url(id: &str) -> String {
    format!("{API}/calendars/{}", urlencode(id))
}

fn urlencode(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

pub fn calendar_from_json(item: &Value) -> Option<RemoteCalendar> {
    Some(RemoteCalendar {
        id: item["id"].as_str()?.to_owned(),
        name: item["summaryOverride"]
            .as_str()
            .or_else(|| item["summary"].as_str())
            .unwrap_or("Calendar")
            .to_owned(),
        color: item["backgroundColor"].as_str().map(str::to_owned),
        primary: item["primary"].as_bool().unwrap_or(false),
        owned: item["accessRole"].as_str() == Some("owner"),
    })
}

fn when_from_json(start: &Value, end: &Value) -> Option<When> {
    if let (Some(s), Some(e)) = (start["dateTime"].as_str(), end["dateTime"].as_str()) {
        return Some(When::Timed {
            start_at: parse_rfc3339(s)?,
            end_at: parse_rfc3339(e)?,
        });
    }
    Some(When::AllDay {
        start: start["date"].as_str()?.to_owned(),
        end: end["date"].as_str()?.to_owned(),
    })
}

pub fn event_from_json(item: &Value) -> Option<RemoteEvent> {
    let cancelled = item["status"].as_str() == Some("cancelled");
    Some(RemoteEvent {
        id: item["id"].as_str()?.to_owned(),
        cancelled,
        title: item["summary"].as_str().unwrap_or("(No title)").to_owned(),
        when: if cancelled {
            None
        } else {
            when_from_json(&item["start"], &item["end"])
        },
        updated: item["updated"]
            .as_str()
            .and_then(parse_rfc3339)
            .unwrap_or(0),
        key: item["extendedProperties"]["private"][KEY_PROPERTY]
            .as_str()
            .map(str::to_owned),
        location: item["location"].as_str().map(str::to_owned),
        link: item["htmlLink"].as_str().map(str::to_owned),
    })
}

pub fn body_to_json(body: &EventBody) -> Value {
    let (start, end, transparency) = match &body.when {
        When::Timed { start_at, end_at } => (
            json!({ "dateTime": format_utc(*start_at) }),
            json!({ "dateTime": format_utc(*end_at) }),
            "opaque",
        ),
        // A day plan does not make the day busy.
        When::AllDay { start, end } => (
            json!({ "date": start }),
            json!({ "date": end }),
            "transparent",
        ),
    };
    json!({
        "summary": body.title,
        "description": body.description,
        "start": start,
        "end": end,
        "transparency": transparency,
        "extendedProperties": { "private": { KEY_PROPERTY: body.key } },
    })
}

impl CalendarProvider for GoogleCalendar {
    fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>> {
        let (items, _) = self.list(
            &format!("{API}/users/me/calendarList"),
            &[("maxResults", "250".into())],
        )?;
        Ok(items.iter().filter_map(calendar_from_json).collect())
    }

    fn create_calendar(&mut self, name: &str) -> ProviderResult<RemoteCalendar> {
        let created = self.call(
            "POST",
            &format!("{API}/calendars"),
            &[],
            Some(&json!({ "summary": name, "description": "Time blocks and day plans from task-master." })),
        )?;
        Ok(RemoteCalendar {
            id: created["id"]
                .as_str()
                .ok_or_else(|| ProviderError::Other("no calendar id".into()))?
                .to_owned(),
            name: name.into(),
            color: None,
            primary: false,
            owned: true,
        })
    }

    fn changes(&mut self, calendar_id: &str, token: Option<&str>) -> ProviderResult<ChangeSet> {
        let mut query = vec![("maxResults", "2500".to_owned())];
        if let Some(t) = token {
            query.push(("syncToken", t.to_owned()));
        }
        let (items, last) = self.list(&format!("{}/events", calendar_url(calendar_id)), &query)?;
        Ok(ChangeSet {
            events: items.iter().filter_map(event_from_json).collect(),
            next_token: last["nextSyncToken"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        })
    }

    fn events_between(
        &mut self,
        calendar_id: &str,
        from: i64,
        to: i64,
    ) -> ProviderResult<Vec<RemoteEvent>> {
        let (items, _) = self.list(
            &format!("{}/events", calendar_url(calendar_id)),
            &[
                ("timeMin", format_utc(from)),
                ("timeMax", format_utc(to)),
                ("singleEvents", "true".into()),
                ("maxResults", "2500".into()),
            ],
        )?;
        Ok(items.iter().filter_map(event_from_json).collect())
    }

    fn insert(&mut self, calendar_id: &str, body: &EventBody) -> ProviderResult<RemoteEvent> {
        let json = self.call(
            "POST",
            &format!("{}/events", calendar_url(calendar_id)),
            &[],
            Some(&body_to_json(body)),
        )?;
        event_from_json(&json).ok_or_else(|| ProviderError::Other("bad event answer".into()))
    }

    fn update(
        &mut self,
        calendar_id: &str,
        event_id: &str,
        body: &EventBody,
    ) -> ProviderResult<RemoteEvent> {
        let json = self.call(
            "PUT",
            &format!(
                "{}/events/{}",
                calendar_url(calendar_id),
                urlencode(event_id)
            ),
            &[],
            Some(&body_to_json(body)),
        )?;
        let event = event_from_json(&json)
            .ok_or_else(|| ProviderError::Other("bad event answer".into()))?;
        // Updating a deleted event revives nothing: treat it as gone.
        if event.cancelled {
            return Err(ProviderError::NotFound);
        }
        Ok(event)
    }

    fn delete(&mut self, calendar_id: &str, event_id: &str) -> ProviderResult<()> {
        match self.call(
            "DELETE",
            &format!(
                "{}/events/{}",
                calendar_url(calendar_id),
                urlencode(event_id)
            ),
            &[],
            None,
        ) {
            Ok(_) | Err(ProviderError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_the_rfc_example() {
        // RFC 7636, appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn sign_in_url_asks_for_offline_access_with_pkce() {
        let url = url::Url::parse(&auth_url("cid", "http://127.0.0.1:5000", "chal", "st")).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert!(q["scope"].contains("calendar.app.created"));
        assert!(!q["scope"].split(' ').any(|s| s.ends_with("/auth/calendar")));
    }

    #[test]
    fn reads_the_redirect() {
        assert_eq!(
            parse_callback("GET /?state=st&code=4%2Fabc&scope=x HTTP/1.1", "st"),
            Ok(Callback::Code("4/abc".into()))
        );
        assert_eq!(
            parse_callback("GET /?error=access_denied&state=st HTTP/1.1", "st"),
            Ok(Callback::Denied("access_denied".into()))
        );
        assert_eq!(
            parse_callback("GET /favicon.ico HTTP/1.1", "st"),
            Ok(Callback::Other)
        );
        assert_eq!(
            parse_callback("", "st"),
            Ok(Callback::Other),
            "a preconnect socket"
        );
        assert!(parse_callback("GET /?code=x&state=other HTTP/1.1", "st").is_err());
    }

    #[test]
    fn the_loopback_listener_waits_for_the_redirect() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            let mut replies = Vec::new();
            // A silent preconnect socket first, as Chrome opens.
            let idle = TcpStream::connect(("127.0.0.1", port)).unwrap();
            drop(idle);
            for path in ["/favicon.ico", "/?code=4%2Fxyz&state=st"] {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(stream, "GET {path} HTTP/1.1\r\nhost: 127.0.0.1\r\n\r\n").unwrap();
                let mut reply = String::new();
                std::io::Read::read_to_string(&mut stream, &mut reply).unwrap();
                replies.push(reply);
            }
            replies
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        assert_eq!(
            receive_code(&listener, "st", deadline, "Google Calendar"),
            Ok("4/xyz".into())
        );
        let replies = browser.join().unwrap();
        assert!(replies[0].contains("Not connected"));
        assert!(replies[1].contains("Connected"));

        let late = TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(
            receive_code(&late, "st", Instant::now(), "Google Calendar")
                .unwrap_err()
                .contains("timed out")
        );
    }

    #[test]
    fn maps_events_both_ways() {
        let timed = json!({
            "id": "ev1",
            "status": "confirmed",
            "summary": "Standup",
            "start": { "dateTime": "2026-11-05T10:00:00+01:00", "timeZone": "Europe/Paris" },
            "end": { "dateTime": "2026-11-05T10:15:00+01:00" },
            "updated": "2026-11-01T08:00:00.123Z",
            "htmlLink": "https://www.google.com/calendar/event?eid=x",
            "extendedProperties": { "private": { "taskMasterKey": "block:abc" } }
        });
        let event = event_from_json(&timed).unwrap();
        assert_eq!(
            event.when,
            Some(When::Timed {
                start_at: 1_793_869_200_000,
                end_at: 1_793_870_100_000
            })
        );
        assert_eq!(event.key.as_deref(), Some("block:abc"));
        assert!(event.updated > 0);

        let all_day = json!({
            "id": "ev2", "summary": "Holiday",
            "start": { "date": "2026-11-06" }, "end": { "date": "2026-11-08" }
        });
        assert_eq!(
            event_from_json(&all_day).unwrap().when,
            Some(When::AllDay {
                start: "2026-11-06".into(),
                end: "2026-11-08".into()
            })
        );
        let cancelled = json!({ "id": "ev3", "status": "cancelled" });
        let gone = event_from_json(&cancelled).unwrap();
        assert!(gone.cancelled && gone.when.is_none());

        let body = body_to_json(&EventBody {
            title: "Write".into(),
            description: "Planned in task-master.".into(),
            when: When::Timed {
                start_at: 1_793_869_200_000,
                end_at: 1_793_872_800_000,
            },
            key: "block:abc".into(),
        });
        assert_eq!(body["start"]["dateTime"], "2026-11-05T09:00:00Z");
        assert_eq!(
            body["extendedProperties"]["private"]["taskMasterKey"],
            "block:abc"
        );
        assert_eq!(body["transparency"], "opaque");
        let plan = body_to_json(&EventBody {
            title: "Plan".into(),
            description: String::new(),
            when: When::AllDay {
                start: "2026-11-05".into(),
                end: "2026-11-06".into(),
            },
            key: "plan:t".into(),
        });
        assert_eq!(plan["start"]["date"], "2026-11-05");
        assert_eq!(plan["transparency"], "transparent");
    }

    #[test]
    fn calendar_ids_are_escaped_in_paths() {
        assert_eq!(
            calendar_url("abc@group.calendar.google.com"),
            format!("{API}/calendars/abc%40group.calendar.google.com")
        );
        let item = json!({ "id": "me@x.com", "summary": "me@x.com", "summaryOverride": "Me",
            "primary": true, "accessRole": "owner", "backgroundColor": "#9fe1e7" });
        let cal = calendar_from_json(&item).unwrap();
        assert_eq!(
            (cal.name.as_str(), cal.primary, cal.owned),
            ("Me", true, true)
        );
    }
}

#[cfg(test)]
mod lease_tests {
    use super::*;
    #[test]
    fn denied_lease_stops_before_token_refresh_or_google_requests() {
        let mut google = GoogleCalendar::new("client", "secret", "refresh");
        google.set_guard(|| Err(ProviderError::Other("lease denied".into())));
        assert_eq!(
            google.calendars().unwrap_err(),
            ProviderError::Other("lease denied".into())
        );
    }
}
