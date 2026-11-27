//! An in-memory CalDAV server (ADR 037): discovery through `/.well-known/caldav`, Basic
//! auth, `sync-collection` with expiring tokens, multiget, time-range queries, ETags with
//! `If-Match`/`If-None-Match`, `MKCALENDAR`.

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use taskmaster_client::caldav::{Request, Response, Transport, xml_escape};
use taskmaster_client::ical;

pub const BASE: &str = "https://dav.example.com";
pub const USER: &str = "alice";
pub const PASSWORD: &str = "app-pass";
const HOME: &str = "/calendars/alice/";
const PRINCIPAL: &str = "/principals/alice/";

#[derive(Debug, Clone)]
pub struct Item {
    pub etag: String,
    pub data: String,
}

#[derive(Debug, Default)]
pub struct Cal {
    pub name: String,
    pub color: Option<String>,
    pub read_only: bool,
    pub todo_only: bool,
    /// Supports `sync-collection`.
    pub sync: bool,
    pub items: BTreeMap<String, Item>,
    /// (sequence, file) of every change.
    pub log: Vec<(u64, String)>,
}

#[derive(Default)]
pub struct FakeDav {
    pub cals: BTreeMap<String, Cal>,
    pub seq: u64,
    /// Sync tokens below this are refused.
    pub expired_before: u64,
    pub requests: Vec<(String, String)>,
    /// PUT answers carry no ETag header.
    pub no_etag_header: bool,
    /// Changes the item just before the next conditional PUT to it (a concurrent edit).
    pub race_next_put: bool,
}

impl FakeDav {
    pub fn new() -> Self {
        let mut dav = Self::default();
        dav.cals.insert(
            "home".into(),
            Cal {
                name: "Home".into(),
                color: Some("#FF2968FF".into()),
                sync: true,
                ..Cal::default()
            },
        );
        dav.cals.insert(
            "shared".into(),
            Cal {
                name: "Family".into(),
                read_only: true,
                sync: true,
                ..Cal::default()
            },
        );
        dav.cals.insert(
            "tasks".into(),
            Cal {
                name: "Reminders".into(),
                todo_only: true,
                sync: true,
                ..Cal::default()
            },
        );
        dav
    }

    pub fn url(slug: &str) -> String {
        format!("{BASE}{HOME}{slug}/")
    }

    fn bump(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// A change made by another client.
    pub fn user_put(&mut self, slug: &str, file: &str, data: &str) {
        let seq = self.bump();
        let cal = self.cals.get_mut(slug).unwrap();
        cal.items.insert(
            file.into(),
            Item {
                etag: format!("\"e{seq}\""),
                data: data.into(),
            },
        );
        cal.log.push((seq, file.into()));
    }

    pub fn user_delete(&mut self, slug: &str, file: &str) {
        let seq = self.bump();
        let cal = self.cals.get_mut(slug).unwrap();
        cal.items.remove(file);
        cal.log.push((seq, file.into()));
    }

    /// The calendar the app created, by name.
    pub fn slug_named(&self, name: &str) -> Option<String> {
        self.cals
            .iter()
            .find(|(_, c)| c.name == name)
            .map(|(s, _)| s.clone())
    }

    /// (file, data) of the item pushed for `key`.
    pub fn by_key(&self, slug: &str, key: &str) -> Option<(String, String)> {
        self.cals[slug]
            .items
            .iter()
            .find(|(_, item)| item.data.contains(&format!("X-TASKMASTER-KEY:{key}\r\n")))
            .map(|(f, item)| (f.clone(), item.data.clone()))
    }

    fn multistatus(responses: &str, token: Option<&str>) -> Response {
        let token = token.map_or_else(String::new, |t| {
            format!("<d:sync-token>{}</d:sync-token>", xml_escape(t))
        });
        Response {
            status: 207,
            headers: vec![],
            body: format!(
                r#"<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">{responses}{token}</d:multistatus>"#
            ),
        }
    }

    fn ok(href: &str, props: &str) -> String {
        format!(
            "<d:response><d:href>{href}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        )
    }

    fn status(code: u16) -> Response {
        Response {
            status: code,
            ..Response::default()
        }
    }

    fn item_data(slug: &str, file: &str, item: &Item) -> String {
        Self::ok(
            &format!("{HOME}{slug}/{file}"),
            &format!(
                "<d:getetag>{}</d:getetag><c:calendar-data>{}</c:calendar-data>",
                xml_escape(&item.etag),
                xml_escape(&item.data)
            ),
        )
    }

    fn handle(&mut self, r: &Request) -> Response {
        let path = r.url.strip_prefix(BASE).unwrap_or(&r.url).to_owned();
        let path = path.split('?').next().unwrap_or("").to_owned();
        if path == "/.well-known/caldav" {
            return Response {
                status: 301,
                headers: vec![("location".into(), "/dav/".into())],
                body: String::new(),
            };
        }
        let expected = format!("Basic {}", STANDARD.encode(format!("{USER}:{PASSWORD}")));
        if r.header("authorization") != Some(expected.as_str()) {
            return Self::status(401);
        }
        match (r.method, path.as_str()) {
            ("PROPFIND", "/") => Self::multistatus(
                &Self::ok("/", "<d:resourcetype><d:collection/></d:resourcetype>"),
                None,
            ),
            ("PROPFIND", "/dav/") => Self::multistatus(
                &Self::ok(
                    "/dav/",
                    &format!(
                        "<d:current-user-principal><d:href>{PRINCIPAL}</d:href></d:current-user-principal>"
                    ),
                ),
                None,
            ),
            ("PROPFIND", PRINCIPAL) => Self::multistatus(
                &Self::ok(
                    PRINCIPAL,
                    &format!("<c:calendar-home-set><d:href>{HOME}</d:href></c:calendar-home-set>"),
                ),
                None,
            ),
            ("PROPFIND", HOME) => {
                let mut out = Self::ok(HOME, "<d:resourcetype><d:collection/></d:resourcetype>");
                for (slug, cal) in &self.cals {
                    let comp = if cal.todo_only { "VTODO" } else { "VEVENT" };
                    let privilege = if cal.read_only {
                        "<d:read/>"
                    } else {
                        "<d:read/><d:write/>"
                    };
                    let sync = if cal.sync {
                        format!("<d:sync-token>tok-{}</d:sync-token>", self.seq)
                    } else {
                        String::new()
                    };
                    let color = cal.color.as_ref().map_or_else(String::new, |c| {
                        format!("<a:calendar-color>{c}</a:calendar-color>")
                    });
                    out.push_str(&Self::ok(
                        &format!("{HOME}{slug}/"),
                        &format!(
                            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>{}</d:displayname>{color}<c:supported-calendar-component-set><c:comp name=\"{comp}\"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege>{privilege}</d:privilege></d:current-user-privilege-set>{sync}",
                            xml_escape(&cal.name)
                        ),
                    ));
                }
                Self::multistatus(&out, None)
            }
            ("MKCALENDAR", p) if p.starts_with(HOME) => {
                let slug = p[HOME.len()..].trim_end_matches('/').to_owned();
                let name =
                    between(&r.body, "<d:displayname>", "</d:displayname>").unwrap_or_default();
                self.cals.insert(
                    slug,
                    Cal {
                        name,
                        sync: true,
                        ..Cal::default()
                    },
                );
                Self::status(201)
            }
            (method, p) if p.starts_with(HOME) => {
                let rest = &p[HOME.len()..];
                let (slug, file) = rest.split_once('/').unwrap_or((rest, ""));
                let (slug, file) = (slug.to_owned(), file.to_owned());
                if !self.cals.contains_key(&slug) {
                    return Self::status(404);
                }
                if file.is_empty() {
                    self.collection(method, &slug, r)
                } else {
                    self.item(method, &slug, &file, r)
                }
            }
            _ => Self::status(404),
        }
    }

    fn collection(&mut self, method: &str, slug: &str, r: &Request) -> Response {
        let cal = &self.cals[slug];
        match method {
            "PROPFIND" => {
                let mut out = Self::ok(
                    &format!("{HOME}{slug}/"),
                    "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>",
                );
                for (file, item) in &cal.items {
                    out.push_str(&Self::ok(
                        &format!("{HOME}{slug}/{file}"),
                        &format!(
                            "<d:resourcetype/><d:getetag>{}</d:getetag>",
                            xml_escape(&item.etag)
                        ),
                    ));
                }
                Self::multistatus(&out, None)
            }
            "REPORT" if r.body.contains("sync-collection") => {
                if !cal.sync {
                    return Self::status(501);
                }
                let token =
                    between(&r.body, "<d:sync-token>", "</d:sync-token>").unwrap_or_default();
                let since = if token.is_empty() {
                    None
                } else {
                    let n: u64 = token.trim_start_matches("tok-").parse().unwrap_or(0);
                    if n < self.expired_before {
                        return Response {
                            status: 403,
                            headers: vec![],
                            body: r#"<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>"#
                                .into(),
                        };
                    }
                    Some(n)
                };
                let files: std::collections::BTreeSet<&String> = match since {
                    None => cal.items.keys().collect(),
                    Some(n) => cal
                        .log
                        .iter()
                        .filter(|(s, _)| *s > n)
                        .map(|(_, f)| f)
                        .collect(),
                };
                let mut out = String::new();
                for file in files {
                    let href = format!("{HOME}{slug}/{file}");
                    match cal.items.get(file) {
                        Some(item) => out.push_str(&Self::ok(&href, &format!("<d:getetag>{}</d:getetag>", xml_escape(&item.etag)))),
                        None => out.push_str(&format!("<d:response><d:href>{href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>")),
                    }
                }
                Self::multistatus(&out, Some(&format!("tok-{}", self.seq)))
            }
            "REPORT" if r.body.contains("calendar-multiget") => {
                let mut out = String::new();
                for href in all_between(&r.body, "<d:href>", "</d:href>") {
                    let file = href.rsplit('/').next().unwrap_or("");
                    if let Some(item) = cal.items.get(file) {
                        out.push_str(&Self::item_data(slug, file, item));
                    }
                }
                Self::multistatus(&out, None)
            }
            "REPORT" if r.body.contains("calendar-query") => {
                let ms = |attr: &str| {
                    let v = between(&r.body, &format!("{attr}=\""), "\"").unwrap();
                    chrono::NaiveDateTime::parse_from_str(&v, "%Y%m%dT%H%M%SZ")
                        .unwrap()
                        .and_utc()
                        .timestamp_millis()
                };
                let (from, to) = (ms("start"), ms("end"));
                let mut out = String::new();
                for (file, item) in &cal.items {
                    let events = ical::events(&ical::parse(&item.data).unwrap());
                    if !ical::expand(&events, from, to).is_empty() {
                        out.push_str(&Self::item_data(slug, file, item));
                    }
                }
                Self::multistatus(&out, None)
            }
            _ => Self::status(405),
        }
    }

    fn item(&mut self, method: &str, slug: &str, file: &str, r: &Request) -> Response {
        let current = self.cals[slug].items.get(file).cloned();
        match method {
            "PROPFIND" => match current {
                Some(item) => Self::multistatus(
                    &Self::ok(
                        &format!("{HOME}{slug}/{file}"),
                        &format!("<d:getetag>{}</d:getetag>", xml_escape(&item.etag)),
                    ),
                    None,
                ),
                None => Self::status(404),
            },
            "PUT" => {
                if self.cals[slug].read_only {
                    return Self::status(403);
                }
                if self.race_next_put
                    && let Some(item) = &current
                    && r.header("if-match").is_some()
                {
                    self.race_next_put = false;
                    let data = item.data.clone();
                    self.user_put(slug, file, &data);
                    return Self::status(412);
                }
                if r.header("if-none-match") == Some("*") && current.is_some() {
                    return Self::status(412);
                }
                if let Some(m) = r.header("if-match") {
                    match &current {
                        None => return Self::status(412),
                        Some(item) if m != "*" && m != item.etag => return Self::status(412),
                        _ => {}
                    }
                }
                ical::parse(&r.body).expect("valid iCalendar");
                let existed = current.is_some();
                self.user_put(slug, file, &r.body);
                let etag = self.cals[slug].items[file].etag.clone();
                Response {
                    status: if existed { 204 } else { 201 },
                    headers: if self.no_etag_header {
                        vec![]
                    } else {
                        vec![("etag".into(), etag)]
                    },
                    body: String::new(),
                }
            }
            "DELETE" => {
                if current.is_none() {
                    return Self::status(404);
                }
                self.user_delete(slug, file);
                Self::status(204)
            }
            _ => Self::status(405),
        }
    }
}

impl Transport for FakeDav {
    fn send(&mut self, request: &Request) -> Result<Response, String> {
        self.requests
            .push((request.method.to_owned(), request.url.clone()));
        Ok(self.handle(request))
    }
}

fn between(text: &str, start: &str, end: &str) -> Option<String> {
    let from = text.find(start)? + start.len();
    let to = text[from..].find(end)? + from;
    Some(text[from..to].to_owned())
}

fn all_between(text: &str, start: &str, end: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(start) {
        let after = &rest[i + start.len()..];
        let Some(j) = after.find(end) else { break };
        out.push(after[..j].to_owned());
        rest = &after[j + end.len()..];
    }
    out
}
