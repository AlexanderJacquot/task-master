//! Calendar sync (M10, ADR 014): pushes time blocks, day plans and deadlines to the app's
//! calendar, brings moves, resizes and deletions made there back as commands, and keeps a
//! read-only copy of the user's other calendars to plan around.
//!
//! The engine is provider-neutral: a [`CalendarProvider`] does the network calls (Google
//! now, CalDAV later, a fake in tests). The store is locked only between network calls,
//! through [`StoreAccess`], so the UI keeps writing while a sync runs.
//!
//! Conflicts: when an item changed in both places since the last sync, the app wins and
//! the next push overwrites the event.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::commands::{Command, TaskChange, TimeBlockChange};
use crate::error::{Error, Result};
use crate::model::{BlockOutcome, Id, IsoDate, Timestamp};
use crate::parse::dates;
use crate::store::Store;
use crate::{MAX_BLOCK_MS, query};

/// Name of the calendar the app creates and pushes to.
pub const TARGET_CALENDAR: &str = "task-master";
/// New links are made for blocks ending, and plans/deadlines dated, at most this long ago.
const PUSH_PAST_MS: i64 = 30 * 86_400_000;
/// The window of other calendars kept locally.
const EVENTS_PAST_MS: i64 = 14 * 86_400_000;
const EVENTS_AHEAD_MS: i64 = 180 * 86_400_000;

// ---------------------------------------------------------------------------------------
// Provider interface

/// A calendar of the connected account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCalendar {
    pub id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: Option<String>,
    pub primary: bool,
    /// The account may write to it (only owned calendars can be the target).
    pub owned: bool,
}

/// When an event happens. All-day `end` is exclusive, as calendars store it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum When {
    Timed {
        start_at: Timestamp,
        end_at: Timestamp,
    },
    AllDay {
        start: IsoDate,
        end: IsoDate,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEvent {
    pub id: String,
    /// Deleted (incremental listings report deletions this way).
    pub cancelled: bool,
    pub title: String,
    /// `None` for cancelled events, which carry no times.
    pub when: Option<When>,
    /// Last change on the server, Unix ms.
    pub updated: Timestamp,
    /// The local item an event was pushed from (a private event property).
    pub key: Option<String>,
    pub location: Option<String>,
    /// A link to open the event in the provider's app.
    pub link: Option<String>,
}

/// An event as the app writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventBody {
    pub title: String,
    pub description: String,
    pub when: When,
    /// `block:<id>`, `plan:<task id>` or `due:<task id>`, stored with the event.
    pub key: String,
}

/// Every event of a calendar changed since `token` (all of them without one), with the
/// token to pass next time.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChangeSet {
    pub events: Vec<RemoteEvent>,
    pub next_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    /// The sync token is no longer valid: list everything again.
    TokenExpired,
    /// The event or calendar does not exist (any more).
    NotFound,
    /// Signed out, revoked or refused: the user must connect again.
    Auth(String),
    Other(String),
}

impl From<ProviderError> for Error {
    fn from(err: ProviderError) -> Self {
        Error::Remote(match err {
            ProviderError::TokenExpired => "the calendar sync token expired".into(),
            ProviderError::NotFound => "calendar or event not found".into(),
            ProviderError::Auth(m) => format!("calendar sign-in needed: {m}"),
            ProviderError::Other(m) => m,
        })
    }
}

pub type ProviderResult<T> = std::result::Result<T, ProviderError>;

/// Network calls to one calendar account.
pub trait CalendarProvider {
    fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>>;
    fn create_calendar(&mut self, name: &str) -> ProviderResult<RemoteCalendar>;
    /// Every page of an incremental listing (or a full one without a token).
    fn changes(&mut self, calendar_id: &str, token: Option<&str>) -> ProviderResult<ChangeSet>;
    /// Live events overlapping `[from, to)`, recurring ones expanded.
    fn events_between(
        &mut self,
        calendar_id: &str,
        from: Timestamp,
        to: Timestamp,
    ) -> ProviderResult<Vec<RemoteEvent>>;
    fn insert(&mut self, calendar_id: &str, body: &EventBody) -> ProviderResult<RemoteEvent>;
    fn update(
        &mut self,
        calendar_id: &str,
        event_id: &str,
        body: &EventBody,
    ) -> ProviderResult<RemoteEvent>;
    /// Deleting an event that is already gone succeeds.
    fn delete(&mut self, calendar_id: &str, event_id: &str) -> ProviderResult<()>;
}

/// Short, exclusive access to the store (a mutex in the desktop shell).
pub trait StoreAccess {
    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R;
}

impl StoreAccess for std::sync::Mutex<Store> {
    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        let mut guard = self
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(&mut guard)
    }
}

impl StoreAccess for std::cell::RefCell<Store> {
    fn with<R>(&self, f: impl FnOnce(&mut Store) -> R) -> R {
        f(&mut self.borrow_mut())
    }
}

// ---------------------------------------------------------------------------------------
// What front ends read

/// A calendar of the connected account, as settings show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CalendarSource {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub primary: bool,
    /// The app's own calendar (blocks, plans and deadlines are pushed there).
    pub target: bool,
    /// Its events are shown in the app.
    pub shown: bool,
    pub synced_at: Option<Timestamp>,
}

/// An event of a shown calendar, read-only in the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct CalendarEvent {
    pub calendar_id: String,
    pub id: String,
    pub title: String,
    /// Timed events.
    pub start_at: Option<Timestamp>,
    pub end_at: Option<Timestamp>,
    /// All-day events; `end_date` is exclusive.
    pub start_date: Option<IsoDate>,
    pub end_date: Option<IsoDate>,
    pub location: Option<String>,
    pub link: Option<String>,
    pub color: Option<String>,
}

/// The range a calendar view shows: times for timed events, local dates for all-day ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct EventRange {
    pub from: Timestamp,
    pub to: Timestamp,
    pub from_date: IsoDate,
    /// Exclusive.
    pub to_date: IsoDate,
}

/// What one sync did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SyncReport {
    /// Events created, updated and deleted in the target calendar.
    pub created: u32,
    pub updated: u32,
    pub deleted: u32,
    /// Local blocks, plans and deadlines changed by edits made in the calendar.
    pub pulled: u32,
    /// Events kept from shown calendars.
    pub events: u32,
}

// ---------------------------------------------------------------------------------------
// The sync

/// One full round: calendars, edits made in the target calendar, the push, then the shown
/// calendars. `today` is the user's local date.
pub fn sync<S: StoreAccess, P: CalendarProvider>(
    store: &S,
    provider: &mut P,
    now: Timestamp,
    today: &str,
) -> Result<SyncReport> {
    crate::clock::check_date("today", today)?;
    let mut report = SyncReport::default();

    // 1. The account's calendars and the target.
    let mut calendars = provider.calendars()?;
    let known = store.with(|s| target_id(s.conn()))?;
    let target = match known.filter(|id| calendars.iter().any(|c| &c.id == id)) {
        Some(id) => id,
        None => match calendars
            .iter()
            .find(|c| c.owned && c.name == TARGET_CALENDAR)
        {
            Some(c) => c.id.clone(),
            None => {
                let created = provider.create_calendar(TARGET_CALENDAR)?;
                let id = created.id.clone();
                calendars.push(created);
                id
            }
        },
    };
    store.with(|s| save_sources(s.conn(), &calendars, &target))?;

    // 2. Edits made in the target calendar.
    let token = store.with(|s| sync_token(s.conn(), &target))?;
    let (changes, full) = match provider.changes(&target, token.as_deref()) {
        Err(ProviderError::TokenExpired) => (provider.changes(&target, None)?, true),
        other => (other?, token.is_none()),
    };
    let orphans = store.with(|s| pull_target(s, &target, &changes.events, full, &mut report))?;
    for event_id in orphans {
        provider.delete(&target, &event_id)?;
        report.deleted += 1;
    }
    store.with(|s| set_sync_token(s.conn(), &target, &changes.next_token, now))?;

    // 3. The push.
    let plan = store.with(|s| push_plan(s.conn(), &target, now, today))?;
    for op in plan {
        match op {
            Push::Insert { key, body, pushed } => {
                let event = provider.insert(&target, &body)?;
                store.with(|s| save_link(s.conn(), &key, &target, &event, &pushed))?;
                report.created += 1;
            }
            Push::Update {
                key,
                event_id,
                body,
                pushed,
            } => {
                let event = match provider.update(&target, &event_id, &body) {
                    // Deleted in the calendar while it changed here: the app wins.
                    Err(ProviderError::NotFound) => provider.insert(&target, &body)?,
                    other => other?,
                };
                store.with(|s| save_link(s.conn(), &key, &target, &event, &pushed))?;
                report.updated += 1;
            }
            Push::Delete { key, event_id } => {
                provider.delete(&target, &event_id)?;
                store.with(|s| unlink(s.conn(), &key))?;
                report.deleted += 1;
            }
        }
    }

    // 4. The shown calendars, in a window around now.
    let shown = store.with(|s| shown_sources(s.conn()))?;
    let (from, to) = (now - EVENTS_PAST_MS, now + EVENTS_AHEAD_MS);
    for calendar_id in shown {
        if calendar_id == target {
            continue;
        }
        let events = provider.events_between(&calendar_id, from, to)?;
        report.events += u32::try_from(events.len()).unwrap_or(u32::MAX);
        store.with(|s| replace_events(s.conn(), &calendar_id, &events, now))?;
    }
    Ok(report)
}

/// Forgets every link and the target's sync token, so the next sync matches events to
/// local items again by their stored key (after an import, or a reconnect).
pub(crate) fn forget_links(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM calendar_links;
         UPDATE calendar_sources SET sync_token = NULL WHERE is_target = 1;",
    )?;
    Ok(())
}

/// Drops all sync state (disconnecting the account). Events stay in the calendar.
pub(crate) fn clear(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "DELETE FROM calendar_links; DELETE FROM calendar_events; DELETE FROM calendar_sources;",
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Local items

/// A local item as it would be pushed.
struct Local {
    fingerprint: String,
    body: EventBody,
}

/// The pushable state of `block:<id>`, `plan:<task id>` or `due:<task id>`; `None` when it
/// should not be in the calendar (deleted, cancelled or missed, no longer planned or due).
fn local_item(conn: &Connection, key: &str) -> Result<Option<Local>> {
    let Some((kind, id)) = key.split_once(':') else {
        return Ok(None);
    };
    let live_task = |id: &str| -> Result<Option<crate::model::Task>> {
        match query::task(conn, id) {
            Ok(t) if t.deleted_at.is_none() => Ok(Some(t)),
            Ok(_) | Err(Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    };
    match kind {
        "block" => {
            let block = match query::time_block(conn, id) {
                Ok(b)
                    if b.deleted_at.is_none()
                        && !matches!(b.outcome, BlockOutcome::Cancelled | BlockOutcome::Missed) =>
                {
                    b
                }
                Ok(_) | Err(Error::NotFound { .. }) => return Ok(None),
                Err(e) => return Err(e),
            };
            let Some(task) = live_task(&block.task_id)? else {
                return Ok(None);
            };
            let done = block.outcome == BlockOutcome::Done;
            let title = format!("{}{}", if done { "✓ " } else { "" }, task.title);
            Ok(Some(Local {
                fingerprint: format!(
                    "block|{title}|{}|{}|{}",
                    block.start_at,
                    block.end_at,
                    block.outcome.as_str()
                ),
                body: EventBody {
                    title,
                    description: match block.outcome {
                        BlockOutcome::Worked => "Worked on in task-master.".into(),
                        BlockOutcome::Done => "Done in task-master.".into(),
                        _ => "Planned in task-master.".into(),
                    },
                    when: When::Timed {
                        start_at: block.start_at,
                        end_at: block.end_at,
                    },
                    key: key.to_owned(),
                },
            }))
        }
        "plan" | "due" => {
            let Some(task) = live_task(id)? else {
                return Ok(None);
            };
            let Some(day) = (if kind == "due" {
                task.due_date.clone()
            } else {
                task.today_on.clone()
            }) else {
                return Ok(None);
            };
            let done: bool = conn.query_row(
                "SELECT category = 'done' FROM statuses WHERE id = ?1",
                [&task.status_id],
                |r| r.get(0),
            )?;
            let title = format!(
                "{}{}{}",
                if done { "✓ " } else { "" },
                if kind == "due" { "Due: " } else { "" },
                task.title
            );
            let end = next_day(&day)?;
            Ok(Some(Local {
                fingerprint: format!("{kind}|{title}|{day}"),
                body: EventBody {
                    title,
                    description: if kind == "due" {
                        "Due on this day in task-master."
                    } else {
                        "Planned for this day in task-master."
                    }
                    .into(),
                    when: When::AllDay { start: day, end },
                    key: key.to_owned(),
                },
            }))
        }
        _ => Ok(None),
    }
}

fn next_day(iso: &str) -> Result<IsoDate> {
    let days = dates::to_days(iso).ok_or_else(|| Error::invalid(format!("bad date '{iso}'")))?;
    Ok(dates::to_iso(days + 1))
}

/// Keys of items not yet in the calendar that should be: recent blocks, plans and deadlines.
fn wanted_keys(conn: &Connection, now: Timestamp, today: &str) -> Result<Vec<String>> {
    let since = dates::to_days(today).map_or_else(String::new, |d| {
        dates::to_iso(d - PUSH_PAST_MS / 86_400_000)
    });
    let mut keys = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT 'block:' || b.id FROM time_blocks b JOIN tasks t ON t.id = b.task_id
         WHERE b.deleted_at IS NULL AND t.deleted_at IS NULL AND b.outcome NOT IN ('cancelled', 'missed')
           AND b.end_at >= ?1
         UNION ALL
         SELECT 'plan:' || id FROM tasks
         WHERE deleted_at IS NULL AND today_on IS NOT NULL AND today_on >= ?2
         UNION ALL
         SELECT 'due:' || id FROM tasks
         WHERE deleted_at IS NULL AND due_date IS NOT NULL AND due_date >= ?2",
    )?;
    let rows = stmt.query_map(params![now - PUSH_PAST_MS, since], |r| r.get(0))?;
    for row in rows {
        keys.push(row?);
    }
    Ok(keys)
}

// ---------------------------------------------------------------------------------------
// Pull from the target calendar

struct Link {
    key: String,
    event_id: String,
    pushed: String,
    remote_updated: Timestamp,
}

fn links(conn: &Connection, calendar_id: &str) -> Result<Vec<Link>> {
    let mut stmt = conn.prepare(
        "SELECT local_key, event_id, pushed, remote_updated FROM calendar_links
         WHERE calendar_id = ?1",
    )?;
    let rows = stmt.query_map([calendar_id], |r| {
        Ok(Link {
            key: r.get(0)?,
            event_id: r.get(1)?,
            pushed: r.get(2)?,
            remote_updated: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The command that makes a local item match a moved event, if it can.
fn follow(conn: &Connection, key: &str, when: &When) -> Result<Option<Command>> {
    let Some((kind, id)) = key.split_once(':') else {
        return Ok(None);
    };
    Ok(match (kind, when) {
        ("block", When::Timed { start_at, end_at }) => {
            let block = query::time_block(conn, id)?;
            let valid = *end_at > *start_at && end_at - start_at <= MAX_BLOCK_MS && *start_at >= 0;
            if !valid || (block.start_at == *start_at && block.end_at == *end_at) {
                None
            } else {
                Some(Command::UpdateTimeBlock {
                    id: id.to_owned(),
                    changes: vec![
                        TimeBlockChange::StartAt(*start_at),
                        TimeBlockChange::EndAt(*end_at),
                    ],
                })
            }
        }
        ("plan", When::AllDay { start, .. }) => {
            let task = query::task(conn, id)?;
            if task.today_on.as_deref() == Some(start.as_str()) {
                None
            } else {
                Some(Command::UpdateTask {
                    id: id.to_owned(),
                    changes: vec![TaskChange::TodayOn(Some(start.clone()))],
                })
            }
        }
        ("due", When::AllDay { start, .. }) => {
            let task = query::task(conn, id)?;
            if task.due_date.as_deref() == Some(start.as_str()) {
                None
            } else {
                Some(Command::UpdateTask {
                    id: id.to_owned(),
                    changes: vec![TaskChange::DueDate(Some(start.clone()))],
                })
            }
        }
        // A block turned into an all-day event (or the reverse): the next push restores it.
        _ => None,
    })
}

/// The command that removes a local item whose event was deleted in the calendar.
fn removal(key: &str) -> Option<Command> {
    let (kind, id) = key.split_once(':')?;
    match kind {
        "block" => Some(Command::DeleteTimeBlock { id: id.to_owned() }),
        "plan" => Some(Command::UpdateTask {
            id: id.to_owned(),
            changes: vec![TaskChange::TodayOn(None)],
        }),
        "due" => Some(Command::UpdateTask {
            id: id.to_owned(),
            changes: vec![TaskChange::DueDate(None)],
        }),
        _ => None,
    }
}

/// Applies the target calendar's changes. Edits to items unchanged here become one batch
/// of commands (one undo); events pushed from items that no longer exist are returned, to
/// be deleted. Events added by hand to the calendar are kept like other calendars' events.
fn pull_target(
    store: &mut Store,
    target: &str,
    events: &[RemoteEvent],
    full: bool,
    report: &mut SyncReport,
) -> Result<Vec<String>> {
    let conn = store.conn();
    let known = links(conn, target)?;
    let by_event: HashMap<&str, &Link> = known.iter().map(|l| (l.event_id.as_str(), l)).collect();
    let linked_keys: HashSet<&str> = known.iter().map(|l| l.key.as_str()).collect();
    let mut commands = Vec::new();
    let mut followed = Vec::new(); // (key, event) whose link is refreshed after the batch
    let mut orphans = Vec::new();
    let mut seen = HashSet::new();
    let mut unlink_keys = Vec::new();
    let mut relinked: HashSet<String> = HashSet::new();
    if full {
        // Events added by hand are listed again below.
        conn.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ?1",
            [target],
        )?;
    }

    for event in events {
        seen.insert(event.id.as_str());
        if let Some(link) = by_event.get(event.id.as_str()) {
            let current = local_item(conn, &link.key)?;
            let unchanged = current
                .as_ref()
                .is_some_and(|l| l.fingerprint == link.pushed);
            if event.cancelled {
                if unchanged && let Some(c) = removal(&link.key) {
                    commands.push(c);
                }
                // Changed here too: forget the link, so the push creates the event again.
                unlink_keys.push(link.key.clone());
                continue;
            }
            if event.updated <= link.remote_updated {
                continue;
            }
            match (&event.when, unchanged) {
                (Some(when), true) => {
                    if let Some(c) = follow(conn, &link.key, when)? {
                        commands.push(c);
                    }
                    followed.push((link.key.clone(), event));
                }
                // Changed here as well (the app wins), or gone here (the push deletes it).
                _ => set_remote_updated(conn, &link.key, event.updated)?,
            }
            continue;
        }
        if event.cancelled {
            conn.execute(
                "DELETE FROM calendar_events WHERE calendar_id = ?1 AND event_id = ?2",
                params![target, event.id],
            )?;
            continue;
        }
        match &event.key {
            // Pushed from here (or from this data on another machine) but not linked.
            Some(key) => {
                let free = !linked_keys.contains(key.as_str()) && !relinked.contains(key);
                if free && local_item(conn, key)?.is_some() {
                    save_link(conn, key, target, event, "")?; // pushed again with current data
                    relinked.insert(key.clone());
                } else {
                    orphans.push(event.id.clone());
                }
            }
            None => upsert_event(conn, target, event)?,
        }
    }

    // A full listing that no longer has a linked event: it was deleted while the sync
    // token was invalid. The app wins: the push creates it again.
    if full {
        for link in &known {
            if !seen.contains(link.event_id.as_str()) {
                unlink_keys.push(link.key.clone());
            }
        }
    }
    for key in &unlink_keys {
        unlink(conn, key)?;
    }

    if !commands.is_empty() {
        report.pulled += u32::try_from(commands.len()).unwrap_or(u32::MAX);
        if let Err(err) = store.execute_all(commands.clone()) {
            // One bad edit must not block the rest: apply them one by one.
            eprintln!("calendar edits as one batch failed ({err}); applying one by one");
            for command in commands {
                let _ = store.execute(command);
            }
        }
    }
    let conn = store.conn();
    for (key, event) in followed {
        let pushed = local_item(conn, &key)?
            .map(|l| l.fingerprint)
            .unwrap_or_default();
        conn.execute(
            "UPDATE calendar_links SET pushed = ?2, remote_updated = ?3 WHERE local_key = ?1",
            params![key, pushed, event.updated],
        )?;
    }
    Ok(orphans)
}

// ---------------------------------------------------------------------------------------
// Push

enum Push {
    Insert {
        key: String,
        body: EventBody,
        pushed: String,
    },
    Update {
        key: String,
        event_id: String,
        body: EventBody,
        pushed: String,
    },
    Delete {
        key: String,
        event_id: String,
    },
}

fn push_plan(conn: &Connection, target: &str, now: Timestamp, today: &str) -> Result<Vec<Push>> {
    let mut out = Vec::new();
    let known = links(conn, target)?;
    let linked: HashSet<&str> = known.iter().map(|l| l.key.as_str()).collect();
    for link in &known {
        match local_item(conn, &link.key)? {
            None => out.push(Push::Delete {
                key: link.key.clone(),
                event_id: link.event_id.clone(),
            }),
            Some(local) if local.fingerprint != link.pushed => out.push(Push::Update {
                key: link.key.clone(),
                event_id: link.event_id.clone(),
                body: local.body,
                pushed: local.fingerprint,
            }),
            Some(_) => {}
        }
    }
    for key in wanted_keys(conn, now, today)? {
        if linked.contains(key.as_str()) {
            continue;
        }
        if let Some(local) = local_item(conn, &key)? {
            out.push(Push::Insert {
                key,
                body: local.body,
                pushed: local.fingerprint,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Sync tables

fn target_id(conn: &Connection) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM calendar_sources WHERE is_target = 1",
            [],
            |r| r.get(0),
        )
        .optional()?)
}

/// Upserts the account's calendars, keeping `shown` choices. A new account shows its
/// primary calendar. A new target forgets old links (they named another calendar).
fn save_sources(conn: &Connection, calendars: &[RemoteCalendar], target: &str) -> Result<()> {
    let previous_target = target_id(conn)?;
    let first_time: bool =
        conn.query_row("SELECT COUNT(*) = 0 FROM calendar_sources", [], |r| {
            r.get(0)
        })?;
    if previous_target.as_deref() != Some(target) {
        forget_links(conn)?;
    }
    let ids: Vec<&str> = calendars.iter().map(|c| c.id.as_str()).collect();
    let mut existing = conn.prepare("SELECT id FROM calendar_sources")?;
    let stale: Vec<String> = existing
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(std::result::Result::ok)
        .filter(|id| !ids.contains(&id.as_str()))
        .collect();
    for id in stale {
        conn.execute("DELETE FROM calendar_sources WHERE id = ?1", [&id])?;
        conn.execute("DELETE FROM calendar_events WHERE calendar_id = ?1", [&id])?;
    }
    for c in calendars {
        let is_target = c.id == target;
        conn.execute(
            "INSERT INTO calendar_sources (id, name, color, is_primary, is_target, shown)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name, color = excluded.color,
               is_primary = excluded.is_primary, is_target = excluded.is_target",
            params![
                c.id,
                c.name,
                c.color,
                c.primary,
                is_target,
                first_time && c.primary && !is_target
            ],
        )?;
    }
    Ok(())
}

fn sync_token(conn: &Connection, calendar_id: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT sync_token FROM calendar_sources WHERE id = ?1",
            [calendar_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten())
}

fn set_sync_token(conn: &Connection, calendar_id: &str, token: &str, now: Timestamp) -> Result<()> {
    conn.execute(
        "UPDATE calendar_sources SET sync_token = NULLIF(?2, ''), synced_at = ?3 WHERE id = ?1",
        params![calendar_id, token, now],
    )?;
    Ok(())
}

fn save_link(
    conn: &Connection,
    key: &str,
    calendar_id: &str,
    event: &RemoteEvent,
    pushed: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM calendar_links WHERE calendar_id = ?1 AND event_id = ?2 AND local_key != ?3",
        params![calendar_id, event.id, key],
    )?;
    conn.execute(
        "INSERT INTO calendar_links (local_key, calendar_id, event_id, pushed, remote_updated)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(local_key) DO UPDATE SET calendar_id = excluded.calendar_id,
           event_id = excluded.event_id, pushed = excluded.pushed,
           remote_updated = excluded.remote_updated",
        params![key, calendar_id, event.id, pushed, event.updated],
    )?;
    Ok(())
}

fn unlink(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM calendar_links WHERE local_key = ?1", [key])?;
    Ok(())
}

fn set_remote_updated(conn: &Connection, key: &str, updated: Timestamp) -> Result<()> {
    conn.execute(
        "UPDATE calendar_links SET remote_updated = ?2 WHERE local_key = ?1",
        params![key, updated],
    )?;
    Ok(())
}

fn shown_sources(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM calendar_sources WHERE shown = 1 AND is_target = 0")?;
    let rows = stmt.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn upsert_event(conn: &Connection, calendar_id: &str, event: &RemoteEvent) -> Result<()> {
    let (start_at, end_at, start_date, end_date) = match &event.when {
        Some(When::Timed { start_at, end_at }) => (Some(*start_at), Some(*end_at), None, None),
        Some(When::AllDay { start, end }) => (None, None, Some(start.clone()), Some(end.clone())),
        None => return Ok(()),
    };
    conn.execute(
        "INSERT OR REPLACE INTO calendar_events
           (calendar_id, event_id, title, start_at, end_at, start_date, end_date, location, link)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            calendar_id,
            event.id,
            event.title,
            start_at,
            end_at,
            start_date,
            end_date,
            event.location,
            event.link
        ],
    )?;
    Ok(())
}

fn replace_events(
    conn: &Connection,
    calendar_id: &str,
    events: &[RemoteEvent],
    now: Timestamp,
) -> Result<()> {
    conn.execute(
        "DELETE FROM calendar_events WHERE calendar_id = ?1",
        [calendar_id],
    )?;
    for event in events.iter().filter(|e| !e.cancelled) {
        upsert_event(conn, calendar_id, event)?;
    }
    conn.execute(
        "UPDATE calendar_sources SET synced_at = ?2 WHERE id = ?1",
        params![calendar_id, now],
    )?;
    Ok(())
}

pub(crate) fn sources(conn: &Connection) -> Result<Vec<CalendarSource>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, color, is_primary, is_target, shown, synced_at FROM calendar_sources
         ORDER BY is_target DESC, is_primary DESC, name, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(CalendarSource {
            id: r.get(0)?,
            name: r.get(1)?,
            color: r.get(2)?,
            primary: r.get(3)?,
            target: r.get(4)?,
            shown: r.get(5)?,
            synced_at: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn set_shown(conn: &Connection, calendar_id: &str, shown: bool) -> Result<()> {
    let n = conn.execute(
        "UPDATE calendar_sources SET shown = ?2 WHERE id = ?1 AND is_target = 0",
        params![calendar_id, shown],
    )?;
    if n == 0 {
        return Err(Error::not_found("calendar", calendar_id));
    }
    if !shown {
        conn.execute(
            "DELETE FROM calendar_events WHERE calendar_id = ?1",
            [calendar_id],
        )?;
    }
    Ok(())
}

/// Events overlapping the range: from shown calendars, and those added by hand to the
/// target calendar.
pub(crate) fn events(conn: &Connection, range: &EventRange) -> Result<Vec<CalendarEvent>> {
    let mut stmt = conn.prepare(
        "SELECT e.calendar_id, e.event_id, e.title, e.start_at, e.end_at, e.start_date,
                e.end_date, e.location, e.link, s.color
         FROM calendar_events e JOIN calendar_sources s ON s.id = e.calendar_id
         WHERE (s.shown = 1 OR s.is_target = 1)
           AND ((e.start_at < ?2 AND e.end_at > ?1)
             OR (e.start_date < ?4 AND e.end_date > ?3))
         ORDER BY COALESCE(e.start_at, 0), e.start_date, e.title, e.event_id",
    )?;
    let rows = stmt.query_map(
        params![range.from, range.to, range.from_date, range.to_date],
        |r| {
            Ok(CalendarEvent {
                calendar_id: r.get(0)?,
                id: r.get(1)?,
                title: r.get(2)?,
                start_at: r.get(3)?,
                end_at: r.get(4)?,
                start_date: r.get(5)?,
                end_date: r.get(6)?,
                location: r.get(7)?,
                link: r.get(8)?,
                color: r.get(9)?,
            })
        },
    )?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

impl Store {
    /// The connected account's calendars (empty when none is connected).
    pub fn calendar_sources(&self) -> Result<Vec<CalendarSource>> {
        sources(self.conn())
    }

    /// Shows or hides another calendar's events (not the app's own calendar).
    pub fn set_calendar_shown(&self, calendar_id: &str, shown: bool) -> Result<()> {
        set_shown(self.conn(), calendar_id, shown)
    }

    pub fn calendar_events(&self, range: &EventRange) -> Result<Vec<CalendarEvent>> {
        events(self.conn(), range)
    }

    /// Forgets the account's calendars, links and cached events (disconnecting).
    pub fn clear_calendar_sync(&self) -> Result<()> {
        clear(self.conn())
    }
}

/// Ids of the target calendar's events, for tests and diagnostics.
pub fn linked_event(store: &Store, key: &str) -> Result<Option<Id>> {
    Ok(store
        .conn()
        .query_row(
            "SELECT event_id FROM calendar_links WHERE local_key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?)
}

// ---------------------------------------------------------------------------------------
// RFC 3339 times, as calendar APIs exchange them

/// `2026-11-05T09:00:00Z` (seconds precision).
pub fn format_utc(ms: Timestamp) -> String {
    let days = ms.div_euclid(86_400_000);
    let secs = ms.rem_euclid(86_400_000) / 1000;
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        dates::to_iso(days),
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// Parses `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` to Unix ms.
pub fn parse_rfc3339(text: &str) -> Option<Timestamp> {
    let (date, rest) = text.split_once(['T', 't'])?;
    let days = dates::to_days(date)?;
    let bytes = rest.as_bytes();
    if bytes.len() < 9 || bytes[2] != b':' || bytes[5] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = rest.get(r)?;
        part.bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (h, m, s) = (num(0..2)?, num(3..5)?, num(6..8)?);
    if h > 23 || m > 59 || s > 60 {
        return None;
    }
    let mut tail = &rest[8..];
    let mut millis = 0;
    if let Some(frac) = tail.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded = format!("{:0<3}", &frac[..digits.min(3)]);
        millis = padded.parse::<i64>().ok()?;
        tail = &frac[digits..];
    }
    let offset_min = match tail {
        "Z" | "z" => 0,
        _ => {
            let sign = match tail.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let (oh, om) = tail[1..].split_once(':')?;
            if oh.len() != 2 || om.len() != 2 {
                return None;
            }
            sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().ok()?)
        }
    };
    Some(((days * 86_400 + h * 3600 + m * 60 + s) - offset_min * 60) * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_roundtrips_and_reads_offsets() {
        let nine_utc = 1_793_869_200_000; // 2026-11-05 09:00 UTC
        assert_eq!(format_utc(nine_utc), "2026-11-05T09:00:00Z");
        assert_eq!(parse_rfc3339("2026-11-05T09:00:00Z"), Some(nine_utc));
        assert_eq!(parse_rfc3339("2026-11-05T10:00:00+01:00"), Some(nine_utc));
        assert_eq!(parse_rfc3339("2026-11-05T04:30:00-04:30"), Some(nine_utc));
        assert_eq!(
            parse_rfc3339("2026-11-05T09:00:00.25Z"),
            Some(nine_utc + 250)
        );
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        for bad in [
            "",
            "2026-11-05",
            "2026-11-05T9:00:00Z",
            "2026-11-05T09:00:00",
            "2026-11-05T25:00:00Z",
            "2026-13-05T09:00:00Z",
            "2026-11-05T09:00:00+0100",
            "2026-11-05T09:00:00.Z",
        ] {
            assert_eq!(parse_rfc3339(bad), None, "{bad}");
        }
    }
}

/// Where the Google Calendar worker runs. Stored outside the replicated data.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CalendarRunner {
    #[default]
    ThisDevice,
    Server,
}

/// Credentials transferred only by an explicit, authenticated runner handoff.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoogleCredentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
}

#[derive(Serialize, Deserialize)]
pub struct RunnerRequest {
    pub runner: CalendarRunner,
    pub device_id: String,
    pub credentials: Option<GoogleCredentials>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RunnerStatus {
    pub runner: CalendarRunner,
    pub connected: bool,
    pub syncing: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub last_report: Option<SyncReport>,
    pub sources: Vec<CalendarSource>,
}

#[derive(Serialize, Deserialize)]
pub struct RunnerTransfer {
    pub status: RunnerStatus,
    pub credentials: Option<GoogleCredentials>,
}

#[derive(Serialize, Deserialize)]
pub struct CalendarLease {
    pub device_id: String,
    #[serde(default)]
    pub release: bool,
}

#[derive(Serialize, Deserialize)]
pub struct CalendarShown {
    pub calendar_id: String,
    pub shown: bool,
}
