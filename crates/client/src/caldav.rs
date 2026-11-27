//! CalDAV calendars (RFC 4791; iCloud, Fastmail, Nextcloud; ADR 037) behind
//! `taskmaster_core::calendar::CalendarProvider`.
//!
//! Discovery: the given URL or `/.well-known/caldav` → `current-user-principal` →
//! `calendar-home-set` → the calendars under it. Edits in a calendar come from a
//! `sync-collection` REPORT (RFC 6578), or, on a server without it, from comparing ETags.
//! Each pushed item is one `VEVENT` resource, written with `If-Match` on its ETag.
//!
//! The network goes through a [`Transport`], so tests run against an in-memory server.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use taskmaster_core::calendar::{
    CalendarProvider, ChangeSet, EventBody, ProviderError, ProviderResult, RemoteCalendar,
    RemoteEvent,
};
use taskmaster_core::{new_id, now_ms};
use url::Url;

use crate::ical;

/// Server presets offered in settings.
pub const ICLOUD_URL: &str = "https://caldav.icloud.com";
pub const FASTMAIL_URL: &str = "https://caldav.fastmail.com";

const DAV: &str = "DAV:";
const CALDAV: &str = "urn:ietf:params:xml:ns:caldav";
const MAX_REDIRECTS: usize = 5;
/// Resources per `calendar-multiget`.
const MULTIGET: usize = 100;
/// Rounds of a truncated `sync-collection` (507) before giving up.
const MAX_SYNC_ROUNDS: usize = 50;
const SYNC_PREFIX: &str = "sync:";
const ETAGS_PREFIX: &str = "etags:";

// ---------------------------------------------------------------------------------------
// Transport

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    /// Lower-case names.
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    /// Lower-case names.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Sends one request as is (no redirects followed).
pub trait Transport: Send {
    fn send(&mut self, request: &Request) -> Result<Response, String>;
}

/// The network.
pub struct HttpTransport {
    agent: ureq::Agent,
}

impl Default for HttpTransport {
    fn default() -> Self {
        Self {
            agent: ureq::Agent::config_builder()
                .timeout_connect(Some(Duration::from_secs(10)))
                .timeout_global(Some(Duration::from_secs(60)))
                .http_status_as_error(false)
                .allow_non_standard_methods(true)
                .max_redirects(0)
                .build()
                .into(),
        }
    }
}

impl Transport for HttpTransport {
    fn send(&mut self, request: &Request) -> Result<Response, String> {
        let method =
            ureq::http::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut builder = ureq::http::Request::builder()
            .method(method)
            .uri(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(*name, value);
        }
        let http = builder
            .body(request.body.clone())
            .map_err(|e| e.to_string())?;
        let mut response = self
            .agent
            .run(http)
            .map_err(|e| format!("could not reach the calendar server: {e}"))?;
        let headers = response
            .headers()
            .iter()
            .map(|(n, v)| {
                (
                    n.as_str().to_ascii_lowercase(),
                    v.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .unwrap_or_default();
        Ok(Response {
            status,
            headers,
            body,
        })
    }
}

// ---------------------------------------------------------------------------------------
// The provider

/// A CalDAV account as settings keep it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// What the user entered (a preset, or their server's address).
    pub server_url: String,
    pub username: String,
    pub password: String,
}

/// A signed-in CalDAV account.
pub struct CaldavCalendar<T: Transport = HttpTransport> {
    transport: T,
    account: Account,
    start: Url,
    home: Option<Url>,
    /// Last ETag seen per resource, for `If-Match`.
    etags: HashMap<String, String>,
    /// UID per resource, for rewriting it.
    uids: HashMap<String, String>,
    /// Calendars that announced no sync token: listed by ETags.
    no_sync: HashSet<String>,
    /// The last `updated` stamp given out (strictly increasing, see [`Self::tick`]).
    clock: i64,
    guard: Option<Box<dyn Fn() -> ProviderResult<()> + Send>>,
}

impl CaldavCalendar<HttpTransport> {
    pub fn new(account: Account, home: Option<&str>) -> ProviderResult<Self> {
        Self::with_transport(HttpTransport::default(), account, home)
    }
}

/// `caldav.icloud.com` → `https://caldav.icloud.com/`.
pub fn normalize_url(text: &str) -> ProviderResult<Url> {
    let text = text.trim();
    if text.is_empty() {
        return Err(ProviderError::Other("enter the server address".into()));
    }
    let with_scheme = if text.contains("://") {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    let mut url = Url::parse(&with_scheme)
        .map_err(|e| ProviderError::Other(format!("not a server address: {e}")))?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() {
        return Err(ProviderError::Other(
            "the server address must start with https://".into(),
        ));
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

impl<T: Transport> CaldavCalendar<T> {
    /// `home` is the calendar home found by an earlier [`discover`](Self::discover).
    pub fn with_transport(
        transport: T,
        account: Account,
        home: Option<&str>,
    ) -> ProviderResult<Self> {
        let start = normalize_url(&account.server_url)?;
        let home = home.and_then(|h| Url::parse(h).ok());
        Ok(Self {
            transport,
            account,
            start,
            home,
            etags: HashMap::new(),
            uids: HashMap::new(),
            no_sync: HashSet::new(),
            clock: 0,
            guard: None,
        })
    }

    /// The `updated` stamp of what is listed or pushed now. CalDAV has no reliable change
    /// time, so events listed as changed get a stamp later than any given before (the
    /// engine skips events not newer than its link), even within one millisecond.
    fn tick(&mut self) -> i64 {
        self.clock = now_ms().max(self.clock + 1);
        self.clock
    }

    /// Checks exclusive runner ownership before every request (ADR 015).
    pub fn set_guard(&mut self, guard: impl Fn() -> ProviderResult<()> + Send + 'static) {
        self.guard = Some(Box::new(guard));
    }

    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }

    pub fn home_url(&self) -> Option<&str> {
        self.home.as_ref().map(Url::as_str)
    }

    /// Finds the calendar home (and checks the password). Returns its URL.
    pub fn discover(&mut self) -> ProviderResult<String> {
        let principal = match self.principal(self.start.clone())? {
            Some(p) => p,
            None => {
                let well_known = self
                    .start
                    .join("/.well-known/caldav")
                    .map_err(|e| ProviderError::Other(e.to_string()))?;
                self.principal(well_known)?.ok_or_else(|| {
                    ProviderError::Other(
                        "no CalDAV account found at this address; check the server URL".into(),
                    )
                })?
            }
        };
        let body = format!(
            r#"<d:propfind xmlns:d="{DAV}" xmlns:c="{CALDAV}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>"#
        );
        let (response, base) = self.dav("PROPFIND", principal, Some("0"), &[], body)?;
        let home = expect_multistatus(&response)?
            .responses
            .iter()
            .find_map(|r| r.prop(CALDAV, "calendar-home-set"))
            .and_then(|p| p.hrefs.first())
            .and_then(|h| base.join(h).ok())
            .ok_or_else(|| ProviderError::Other("the server named no calendar home".into()))?;
        let home = with_slash(home);
        self.home = Some(home.clone());
        Ok(home.into())
    }

    /// The principal URL announced at `url`, if any.
    fn principal(&mut self, url: Url) -> ProviderResult<Option<Url>> {
        let body = format!(
            r#"<d:propfind xmlns:d="{DAV}"><d:prop><d:current-user-principal/></d:prop></d:propfind>"#
        );
        let (response, base) = self.dav("PROPFIND", url, Some("0"), &[], body)?;
        if response.status != 207 {
            return Ok(None);
        }
        Ok(parse_multistatus(&response.body)?
            .responses
            .iter()
            .find_map(|r| r.prop(DAV, "current-user-principal"))
            .and_then(|p| p.hrefs.first())
            .and_then(|h| base.join(h).ok()))
    }

    fn home(&mut self) -> ProviderResult<Url> {
        match &self.home {
            Some(home) => Ok(home.clone()),
            None => {
                self.discover()?;
                self.home
                    .clone()
                    .ok_or_else(|| ProviderError::Other("no calendar home".into()))
            }
        }
    }

    /// May the password go to this URL? The configured host and its siblings under the
    /// same domain (iCloud answers from `pNN-caldav.icloud.com`), never plain HTTP to
    /// another host.
    fn may_authenticate(&self, url: &Url) -> bool {
        let (Some(host), Some(start)) = (url.host_str(), self.start.host_str()) else {
            return false;
        };
        if host == start {
            return url.scheme() == self.start.scheme() || url.scheme() == "https";
        }
        let domain = |h: &str| {
            let labels: Vec<&str> = h.rsplit('.').take(2).collect();
            labels.into_iter().rev().collect::<Vec<_>>().join(".")
        };
        url.scheme() == "https" && domain(host) == domain(start) && host.contains('.')
    }

    /// One WebDAV request, following redirects (same method and body). Returns the
    /// answer and the URL that gave it, to resolve the hrefs it holds.
    fn dav(
        &mut self,
        method: &'static str,
        url: Url,
        depth: Option<&str>,
        extra: &[(&'static str, String)],
        body: String,
    ) -> ProviderResult<(Response, Url)> {
        let mut url = url;
        for _ in 0..=MAX_REDIRECTS {
            if let Some(guard) = &self.guard {
                guard()?;
            }
            let mut headers: Vec<(&'static str, String)> = Vec::new();
            if self.may_authenticate(&url) {
                let pair = format!("{}:{}", self.account.username, self.account.password);
                headers.push(("authorization", format!("Basic {}", STANDARD.encode(pair))));
            }
            if let Some(depth) = depth {
                headers.push(("depth", depth.to_owned()));
            }
            if !body.is_empty() {
                let kind = if method == "PUT" {
                    "text/calendar; charset=utf-8"
                } else {
                    "application/xml; charset=utf-8"
                };
                headers.push(("content-type", kind.to_owned()));
            }
            headers.extend(extra.iter().cloned());
            let request = Request {
                method,
                url: url.to_string(),
                headers,
                body: body.clone(),
            };
            let response = self
                .transport
                .send(&request)
                .map_err(ProviderError::Other)?;
            match response.status {
                301 | 302 | 307 | 308 => {
                    let next = response
                        .header("location")
                        .and_then(|l| url.join(l).ok())
                        .ok_or_else(|| {
                            ProviderError::Other("a redirect without a target".into())
                        })?;
                    url = next;
                }
                401 => {
                    return Err(ProviderError::Auth(
                        "the calendar server refused the user name or password (iCloud needs \
                         an app-specific password)"
                            .into(),
                    ));
                }
                _ => return Ok((response, url)),
            }
        }
        Err(ProviderError::Other("too many redirects".into()))
    }

    /// A calendar id (its URL) as a URL.
    fn calendar_url(calendar_id: &str) -> ProviderResult<Url> {
        Url::parse(calendar_id)
            .map(with_slash)
            .map_err(|_| ProviderError::NotFound)
    }

    /// Changed resources' calendar data, in batches.
    fn multiget(&mut self, calendar: &Url, hrefs: &[String]) -> ProviderResult<Vec<Resource>> {
        let mut out = Vec::new();
        for chunk in hrefs.chunks(MULTIGET) {
            let refs: String = chunk
                .iter()
                .map(|h| {
                    let path = Url::parse(h).map_or_else(|_| h.clone(), |u| u.path().to_owned());
                    format!("<d:href>{}</d:href>", xml_escape(&path))
                })
                .collect();
            let body = format!(
                r#"<c:calendar-multiget xmlns:d="{DAV}" xmlns:c="{CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop>{refs}</c:calendar-multiget>"#
            );
            let (response, base) = self.dav("REPORT", calendar.clone(), Some("1"), &[], body)?;
            out.extend(resources(&expect_multistatus(&response)?, &base));
        }
        Ok(out)
    }

    /// The target calendar's events as one [`RemoteEvent`] per resource.
    fn remote_events(&mut self, resources: &[Resource]) -> Vec<RemoteEvent> {
        let now = self.tick();
        let mut out = Vec::new();
        for resource in resources {
            self.etags
                .insert(resource.href.clone(), resource.etag.clone());
            let Ok(calendars) = ical::parse(&resource.data) else {
                continue;
            };
            let events = ical::events(&calendars);
            let Some(event) = events
                .iter()
                .find(|e| e.recurrence_id.is_none())
                .or_else(|| events.first())
            else {
                continue;
            };
            self.uids.insert(resource.href.clone(), event.uid.clone());
            let when = ical::event_when(event);
            out.push(RemoteEvent {
                id: resource.href.clone(),
                cancelled: event.cancelled || when.is_none(),
                title: event.summary.clone().unwrap_or_else(|| "(No title)".into()),
                when: if event.cancelled { None } else { when },
                // Whatever a listing of changes returns changed (or is the echo of a
                // push): the engine compares the times themselves.
                updated: now,
                key: event.key.clone(),
                location: event.location.clone(),
                link: None,
                // TRANSP and CLASS are not read yet (ADR 038): the meeting is left as it is.
                show_as: None,
                private: None,
            });
        }
        out
    }

    fn removed(&mut self, href: String) -> RemoteEvent {
        self.etags.remove(&href);
        RemoteEvent {
            id: href,
            cancelled: true,
            title: String::new(),
            when: None,
            updated: self.tick(),
            key: None,
            location: None,
            link: None,
            show_as: None,
            private: None,
        }
    }

    /// `sync-collection`; `None` when the server does not do it for this calendar.
    fn sync_collection(
        &mut self,
        calendar: &Url,
        token: Option<&str>,
    ) -> ProviderResult<Option<ChangeSet>> {
        let mut token = token.unwrap_or_default().to_owned();
        let mut changed: BTreeMap<String, ()> = BTreeMap::new();
        let mut gone: Vec<String> = Vec::new();
        for _ in 0..MAX_SYNC_ROUNDS {
            let body = format!(
                r#"<d:sync-collection xmlns:d="{DAV}"><d:sync-token>{}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>"#,
                xml_escape(&token)
            );
            let (response, base) = self.dav("REPORT", calendar.clone(), None, &[], body)?;
            match response.status {
                207 => {}
                403 | 409 | 410 if !token.is_empty() => {
                    if response.status == 410 || response.body.contains("valid-sync-token") {
                        return Err(ProviderError::TokenExpired);
                    }
                    return Err(status_error(&response));
                }
                400 | 403 | 405 | 415 | 501 if token.is_empty() => return Ok(None),
                404 => return Err(ProviderError::NotFound),
                _ => return Err(status_error(&response)),
            }
            let listing = parse_multistatus(&response.body)?;
            let mut truncated = false;
            for r in &listing.responses {
                let Ok(href) = base.join(&r.href) else {
                    continue;
                };
                if same_collection(&href, calendar) {
                    truncated |= r.status == Some(507);
                    continue;
                }
                let href = href.to_string();
                if r.status == Some(404) {
                    changed.remove(&href);
                    gone.push(href);
                } else if r.prop(DAV, "getetag").is_some() {
                    gone.retain(|g| *g != href);
                    changed.insert(href, ());
                }
            }
            token = listing
                .sync_token
                .ok_or_else(|| ProviderError::Other("the server sent no sync token".into()))?;
            if !truncated {
                let hrefs: Vec<String> = changed.into_keys().collect();
                let resources = self.multiget(calendar, &hrefs)?;
                let mut events = self.remote_events(&resources);
                for href in gone {
                    events.push(self.removed(href));
                }
                return Ok(Some(ChangeSet {
                    events,
                    next_token: format!("{SYNC_PREFIX}{token}"),
                }));
            }
        }
        Err(ProviderError::Other(
            "the server's change list did not end".into(),
        ))
    }

    /// Every resource's ETag (for servers without sync tokens).
    fn list_etags(&mut self, calendar: &Url) -> ProviderResult<BTreeMap<String, String>> {
        let body = format!(
            r#"<d:propfind xmlns:d="{DAV}"><d:prop><d:resourcetype/><d:getetag/></d:prop></d:propfind>"#
        );
        let (response, base) = self.dav("PROPFIND", calendar.clone(), Some("1"), &[], body)?;
        if response.status == 404 {
            return Err(ProviderError::NotFound);
        }
        let mut out = BTreeMap::new();
        for r in expect_multistatus(&response)?.responses {
            let Ok(href) = base.join(&r.href) else {
                continue;
            };
            let collection = r
                .prop(DAV, "resourcetype")
                .is_some_and(|p| p.names.iter().any(|n| n == "collection"));
            if same_collection(&href, calendar) || collection {
                continue;
            }
            if let Some(etag) = r.prop(DAV, "getetag") {
                out.insert(href.to_string(), etag.text.clone());
            }
        }
        Ok(out)
    }

    fn changes_by_etags(
        &mut self,
        calendar: &Url,
        token: Option<&str>,
    ) -> ProviderResult<ChangeSet> {
        let before: BTreeMap<String, String> = token
            .and_then(|t| t.strip_prefix(ETAGS_PREFIX))
            .and_then(|json| serde_json::from_str(json).ok())
            .unwrap_or_default();
        let now_listing = self.list_etags(calendar)?;
        let changed: Vec<String> = now_listing
            .iter()
            .filter(|(href, etag)| before.get(*href) != Some(*etag))
            .map(|(href, _)| href.clone())
            .collect();
        let resources = self.multiget(calendar, &changed)?;
        let mut events = self.remote_events(&resources);
        for href in before.keys().filter(|h| !now_listing.contains_key(*h)) {
            events.push(self.removed(href.clone()));
        }
        Ok(ChangeSet {
            events,
            next_token: format!(
                "{ETAGS_PREFIX}{}",
                serde_json::to_string(&now_listing).unwrap_or_default()
            ),
        })
    }

    /// The current ETag of a resource; `NotFound` when it is gone.
    fn etag_of(&mut self, href: &Url) -> ProviderResult<Option<String>> {
        let body =
            format!(r#"<d:propfind xmlns:d="{DAV}"><d:prop><d:getetag/></d:prop></d:propfind>"#);
        let (response, _) = self.dav("PROPFIND", href.clone(), Some("0"), &[], body)?;
        match response.status {
            207 => Ok(parse_multistatus(&response.body)?
                .responses
                .iter()
                .find_map(|r| r.prop(DAV, "getetag"))
                .map(|p| p.text.clone())),
            404 | 410 => Err(ProviderError::NotFound),
            _ => Err(status_error(&response)),
        }
    }

    fn put(
        &mut self,
        href: &Url,
        uid: &str,
        body: &EventBody,
        condition: (&'static str, String),
    ) -> ProviderResult<Response> {
        let data = ical::write_event(uid, body, now_ms());
        let (response, _) = self.dav("PUT", href.clone(), None, &[condition], data)?;
        Ok(response)
    }

    fn pushed(
        &mut self,
        href: &Url,
        uid: &str,
        body: &EventBody,
        response: &Response,
    ) -> RemoteEvent {
        let id = href.to_string();
        match response.header("etag") {
            Some(etag) => self.etags.insert(id.clone(), etag.to_owned()),
            // No ETag in the answer: read it before the next update.
            None => self.etags.remove(&id),
        };
        self.uids.insert(id.clone(), uid.to_owned());
        RemoteEvent {
            id,
            cancelled: false,
            title: body.title.clone(),
            when: Some(body.when.clone()),
            updated: self.tick(),
            key: Some(body.key.clone()),
            location: None,
            link: None,
            show_as: None,
            private: None,
        }
    }
}

impl<T: Transport> CaldavCalendar<T> {
    /// The home's calendars; `None` when the home is gone (moved).
    fn list_calendars(&mut self) -> ProviderResult<Option<Vec<RemoteCalendar>>> {
        let home = self.home()?;
        let body = format!(
            r#"<d:propfind xmlns:d="{DAV}" xmlns:c="{CALDAV}" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/><d:current-user-privilege-set/><d:sync-token/></d:prop></d:propfind>"#
        );
        let (response, base) = self.dav("PROPFIND", home.clone(), Some("1"), &[], body)?;
        if response.status == 404 {
            return Ok(None);
        }
        let mut out = Vec::new();
        for r in expect_multistatus(&response)?.responses {
            let Ok(url) = base.join(&r.href).map(with_slash) else {
                continue;
            };
            let is_calendar = r
                .prop(DAV, "resourcetype")
                .is_some_and(|p| p.names.iter().any(|n| n == "calendar"));
            if !is_calendar || same_collection(&url, &home) {
                continue;
            }
            let comps = r
                .prop(CALDAV, "supported-calendar-component-set")
                .map(|p| p.comps.clone())
                .unwrap_or_default();
            if !comps.is_empty() && !comps.iter().any(|c| c.eq_ignore_ascii_case("VEVENT")) {
                continue; // a reminders list
            }
            let owned = r.prop(DAV, "current-user-privilege-set").is_none_or(|p| {
                p.names
                    .iter()
                    .any(|n| matches!(n.as_str(), "all" | "write" | "write-content"))
            });
            let id = url.to_string();
            if r.prop(DAV, "sync-token").is_none_or(|p| p.text.is_empty()) {
                self.no_sync.insert(id.clone());
            } else {
                self.no_sync.remove(&id);
            }
            let name = r
                .prop(DAV, "displayname")
                .map(|p| p.text.trim().to_owned())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| "Calendar".into());
            let color = r
                .prop("http://apple.com/ns/ical/", "calendar-color")
                .and_then(|p| css_color(&p.text));
            out.push(RemoteCalendar {
                id,
                name,
                color,
                primary: false,
                owned,
            });
        }
        // CalDAV has no main calendar: the first writable one stands for it (it is shown
        // by default on the first sync).
        if let Some(first) = out
            .iter_mut()
            .find(|c| c.owned && c.name != taskmaster_core::calendar::TARGET_CALENDAR)
        {
            first.primary = true;
        }
        Ok(Some(out))
    }
}

impl<T: Transport> CalendarProvider for CaldavCalendar<T> {
    fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>> {
        if let Some(calendars) = self.list_calendars()? {
            return Ok(calendars);
        }
        // The home moved (another iCloud partition): find it again, once.
        self.home = None;
        self.discover()?;
        self.list_calendars()?
            .ok_or_else(|| ProviderError::Other("the calendar home cannot be found".into()))
    }

    fn create_calendar(&mut self, name: &str) -> ProviderResult<RemoteCalendar> {
        let home = self.home()?;
        let url = home
            .join(&format!("{}/", new_id()))
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let body = format!(
            r#"<c:mkcalendar xmlns:d="{DAV}" xmlns:c="{CALDAV}"><d:set><d:prop><d:displayname>{}</d:displayname><c:calendar-description>Time blocks, day plans and deadlines from task-master.</c:calendar-description><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>"#,
            xml_escape(name)
        );
        let (response, _) = self.dav("MKCALENDAR", url.clone(), None, &[], body)?;
        if !matches!(response.status, 200 | 201) {
            return Err(status_error(&response));
        }
        Ok(RemoteCalendar {
            id: url.to_string(),
            name: name.into(),
            color: None,
            primary: false,
            owned: true,
        })
    }

    fn changes(&mut self, calendar_id: &str, token: Option<&str>) -> ProviderResult<ChangeSet> {
        let calendar = Self::calendar_url(calendar_id)?;
        match token {
            Some(t) if t.starts_with(ETAGS_PREFIX) => self.changes_by_etags(&calendar, token),
            Some(t) => {
                let t = t.strip_prefix(SYNC_PREFIX).unwrap_or(t);
                match self.sync_collection(&calendar, Some(t))? {
                    Some(set) => Ok(set),
                    None => Err(ProviderError::TokenExpired),
                }
            }
            None if self.no_sync.contains(calendar.as_str()) => {
                self.changes_by_etags(&calendar, None)
            }
            None => match self.sync_collection(&calendar, None)? {
                Some(set) => Ok(set),
                None => self.changes_by_etags(&calendar, None),
            },
        }
    }

    fn events_between(
        &mut self,
        calendar_id: &str,
        from: i64,
        to: i64,
    ) -> ProviderResult<Vec<RemoteEvent>> {
        let calendar = Self::calendar_url(calendar_id)?;
        let stamp = |ms: i64| taskmaster_core::calendar::format_utc(ms).replace(['-', ':'], "");
        let body = format!(
            r#"<c:calendar-query xmlns:d="{DAV}" xmlns:c="{CALDAV}"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{}" end="{}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"#,
            stamp(from),
            stamp(to)
        );
        let (response, base) = self.dav("REPORT", calendar, Some("1"), &[], body)?;
        if response.status == 404 {
            return Err(ProviderError::NotFound);
        }
        let mut out = Vec::new();
        for resource in resources(&expect_multistatus(&response)?, &base) {
            let Ok(calendars) = ical::parse(&resource.data) else {
                continue;
            };
            let events = ical::events(&calendars);
            for occurrence in ical::expand(&events, from, to) {
                let event = occurrence.event;
                out.push(RemoteEvent {
                    id: match &occurrence.instance {
                        Some(instance) => format!("{}#{instance}", resource.href),
                        None => resource.href.clone(),
                    },
                    cancelled: false,
                    title: event.summary.clone().unwrap_or_else(|| "(No title)".into()),
                    when: Some(occurrence.when.clone()),
                    updated: event.last_modified.map_or(0, |t| t.timestamp_millis()),
                    key: event.key.clone(),
                    location: event.location.clone(),
                    link: None,
                    show_as: None,
                    private: None,
                });
            }
        }
        Ok(out)
    }

    fn insert(&mut self, calendar_id: &str, body: &EventBody) -> ProviderResult<RemoteEvent> {
        let calendar = Self::calendar_url(calendar_id)?;
        let uid = new_id();
        let href = calendar
            .join(&format!("{uid}.ics"))
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        let response = self.put(&href, &uid, body, ("if-none-match", "*".into()))?;
        match response.status {
            200 | 201 | 204 => Ok(self.pushed(&href, &uid, body, &response)),
            404 | 409 => Err(ProviderError::NotFound),
            _ => Err(status_error(&response)),
        }
    }

    fn update(
        &mut self,
        _calendar_id: &str,
        event_id: &str,
        body: &EventBody,
    ) -> ProviderResult<RemoteEvent> {
        let href = Url::parse(event_id).map_err(|_| ProviderError::NotFound)?;
        let uid = self.uids.get(event_id).cloned().unwrap_or_else(|| {
            // Pushed from here: the file is named after the UID.
            let name = href
                .path_segments()
                .and_then(|mut s| s.next_back())
                .unwrap_or("");
            percent_decode(name.strip_suffix(".ics").unwrap_or(name))
        });
        let mut etag = match self.etags.get(event_id).cloned() {
            Some(etag) => Some(etag),
            None => self.etag_of(&href)?,
        };
        for attempt in 0..2 {
            let condition = match &etag {
                Some(e) => ("if-match", e.clone()),
                // A server that gives no ETags: the resource exists (just checked).
                None => ("if-match", "*".into()),
            };
            let response = self.put(&href, &uid, body, condition)?;
            match response.status {
                200 | 201 | 204 => return Ok(self.pushed(&href, &uid, body, &response)),
                404 | 410 => return Err(ProviderError::NotFound),
                // Changed in the calendar meanwhile: the app wins, once more with the
                // new ETag (or NotFound when it was deleted).
                412 if attempt == 0 => etag = self.etag_of(&href)?,
                _ => return Err(status_error(&response)),
            }
        }
        Err(ProviderError::Other(
            "the event kept changing on the server".into(),
        ))
    }

    fn delete(&mut self, _calendar_id: &str, event_id: &str) -> ProviderResult<()> {
        let Ok(href) = Url::parse(event_id) else {
            return Ok(());
        };
        let (response, _) = self.dav("DELETE", href, None, &[], String::new())?;
        self.etags.remove(event_id);
        self.uids.remove(event_id);
        match response.status {
            200 | 202 | 204 | 404 | 410 => Ok(()),
            _ => Err(status_error(&response)),
        }
    }
}

fn status_error(response: &Response) -> ProviderError {
    let detail = response
        .body
        .split(['<', '>'])
        .map(str::trim)
        .find(|s| !s.is_empty() && s.len() < 200 && !s.contains('=') && !s.contains(':'))
        .unwrap_or("");
    let detail = if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    };
    ProviderError::Other(format!(
        "the calendar server answered HTTP {}{detail}",
        response.status
    ))
}

fn with_slash(mut url: Url) -> Url {
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    url
}

fn same_collection(a: &Url, b: &Url) -> bool {
    let key = |u: &Url| {
        format!(
            "{}{}",
            u.host_str().unwrap_or(""),
            percent_decode(u.path()).trim_end_matches('/')
        )
    };
    key(a) == key(b)
}

/// `%40` → `@` (invalid sequences kept as written).
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(h), Some(l)) = (
                bytes.get(i + 1).and_then(|b| hex(*b)),
                bytes.get(i + 2).and_then(|b| hex(*b)),
            )
        {
            out.push(u8::try_from(h * 16 + l).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `#RRGGBBAA` (Apple) → `#rrggbb`.
fn css_color(text: &str) -> Option<String> {
    let text = text.trim();
    let hex = text.strip_prefix('#')?;
    (hex.len() >= 6 && hex[..6].bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex[..6].to_ascii_lowercase()))
}

pub fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ---------------------------------------------------------------------------------------
// Multistatus replies

/// A `207 Multi-Status` reply.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Multistatus {
    pub responses: Vec<DavResponse>,
    pub sync_token: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct DavResponse {
    pub href: String,
    /// The response's own status (deleted members in a sync report), if given.
    pub status: Option<u16>,
    /// Properties found (`200` propstats only).
    pub props: Vec<Prop>,
}

impl DavResponse {
    pub fn prop(&self, ns: &str, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.ns == ns && p.name == name)
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Prop {
    pub ns: String,
    pub name: String,
    /// All text inside, trimmed.
    pub text: String,
    /// `href`s inside.
    pub hrefs: Vec<String>,
    /// Local names of the elements inside.
    pub names: Vec<String>,
    /// `name` attributes of `comp` elements inside.
    pub comps: Vec<String>,
}

fn expect_multistatus(response: &Response) -> ProviderResult<Multistatus> {
    if response.status != 207 {
        return Err(status_error(response));
    }
    parse_multistatus(&response.body)
}

pub fn parse_multistatus(body: &str) -> ProviderResult<Multistatus> {
    let doc = roxmltree::Document::parse(body)
        .map_err(|e| ProviderError::Other(format!("the calendar server sent bad XML: {e}")))?;
    let is = |n: &roxmltree::Node, name: &str| {
        n.is_element() && n.tag_name().name() == name && n.tag_name().namespace() == Some(DAV)
    };
    let text_of = |n: &roxmltree::Node| -> String {
        n.descendants()
            .filter(roxmltree::Node::is_text)
            .filter_map(|t| t.text())
            .collect::<String>()
            .trim()
            .to_owned()
    };
    let status_code = |text: &str| -> Option<u16> { text.split_whitespace().nth(1)?.parse().ok() };
    let root = doc.root_element();
    let mut out = Multistatus::default();
    for child in root.children() {
        if is(&child, "sync-token") {
            out.sync_token = Some(text_of(&child));
        }
        if !is(&child, "response") {
            continue;
        }
        let mut response = DavResponse::default();
        for part in child.children() {
            if is(&part, "href") {
                response.href = text_of(&part);
            } else if is(&part, "status") {
                response.status = status_code(&text_of(&part));
            } else if is(&part, "propstat") {
                let ok = part
                    .children()
                    .find(|n| is(n, "status"))
                    .and_then(|n| status_code(&text_of(&n)))
                    .is_none_or(|s| (200..300).contains(&s));
                if !ok {
                    continue;
                }
                for prop in part.children().filter(|n| is(n, "prop")) {
                    for p in prop.children().filter(roxmltree::Node::is_element) {
                        let inner = p.descendants().skip(1).filter(roxmltree::Node::is_element);
                        response.props.push(Prop {
                            ns: p.tag_name().namespace().unwrap_or("").to_owned(),
                            name: p.tag_name().name().to_owned(),
                            text: text_of(&p),
                            hrefs: inner
                                .clone()
                                .filter(|n| is(n, "href"))
                                .map(|n| text_of(&n))
                                .collect(),
                            names: inner
                                .clone()
                                .map(|n| n.tag_name().name().to_owned())
                                .collect(),
                            comps: inner
                                .filter(|n| n.tag_name().name() == "comp")
                                .filter_map(|n| n.attribute("name").map(str::to_owned))
                                .collect(),
                        });
                    }
                }
            }
        }
        out.responses.push(response);
    }
    Ok(out)
}

/// A calendar resource with its data.
struct Resource {
    href: String,
    etag: String,
    data: String,
}

fn resources(listing: &Multistatus, base: &Url) -> Vec<Resource> {
    listing
        .responses
        .iter()
        .filter_map(|r| {
            let data = r.prop(CALDAV, "calendar-data")?;
            Some(Resource {
                href: base.join(&r.href).ok()?.to_string(),
                etag: r
                    .prop(DAV, "getetag")
                    .map(|p| p.text.clone())
                    .unwrap_or_default(),
                data: data.text.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_multistatus_replies() {
        let body = r#"<?xml version="1.0"?>
            <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">
              <d:response><d:href>/cal/home/work/</d:href>
                <d:propstat><d:prop>
                  <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
                  <d:displayname>Work</d:displayname>
                  <a:calendar-color>#FF2968FF</a:calendar-color>
                  <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
                </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
                <d:propstat><d:prop><d:sync-token/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
              </d:response>
              <d:response><d:href>/cal/home/work/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>
              <d:sync-token>http://x/sync/42</d:sync-token>
            </d:multistatus>"#;
        let m = parse_multistatus(body).unwrap();
        assert_eq!(m.sync_token.as_deref(), Some("http://x/sync/42"));
        let work = &m.responses[0];
        assert!(
            work.prop(DAV, "resourcetype")
                .unwrap()
                .names
                .contains(&"calendar".into())
        );
        assert_eq!(work.prop(DAV, "displayname").unwrap().text, "Work");
        assert!(
            work.prop(DAV, "sync-token").is_none(),
            "404 propstats are left out"
        );
        assert_eq!(
            work.prop(CALDAV, "supported-calendar-component-set")
                .unwrap()
                .comps,
            ["VEVENT"]
        );
        assert_eq!(css_color("#FF2968FF").as_deref(), Some("#ff2968"));
        assert_eq!(m.responses[1].status, Some(404));
        assert!(parse_multistatus("<not xml").is_err());
    }

    #[test]
    fn server_addresses_and_where_the_password_goes() {
        assert_eq!(
            normalize_url("caldav.icloud.com").unwrap().as_str(),
            "https://caldav.icloud.com/"
        );
        assert_eq!(
            normalize_url("https://cloud.example.org/remote.php/dav")
                .unwrap()
                .as_str(),
            "https://cloud.example.org/remote.php/dav/"
        );
        assert!(normalize_url("").is_err());
        assert!(normalize_url("ftp://x").is_err());
        let account = Account {
            server_url: ICLOUD_URL.into(),
            username: "me@icloud.com".into(),
            password: "abcd-efgh-ijkl-mnop".into(),
        };
        let cal = CaldavCalendar::new(account, None).unwrap();
        let ok = |u: &str| cal.may_authenticate(&Url::parse(u).unwrap());
        assert!(ok("https://caldav.icloud.com/123/principal/"));
        assert!(ok("https://p42-caldav.icloud.com/123/calendars/"));
        assert!(!ok("https://evil.example.com/"));
        assert!(
            !ok("http://p42-caldav.icloud.com/"),
            "never in clear to another host"
        );
    }
}
