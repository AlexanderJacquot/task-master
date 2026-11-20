//! Classic Outlook's object model (Windows): the calendar folders of the profile, their
//! appointments, and the private property naming the local item an event was pushed from.

use std::collections::HashMap;

use taskmaster_core::calendar::{
    ChangeSet, EventBody, ProviderError, ProviderResult, RemoteCalendar, RemoteEvent, When,
};

use crate::com::{Apartment, Arg, Dispatch, Error, Value, short_date};
use crate::model::{self, Seen, date_ole, entry_id, event_id, ms_to_ole, ole_date, ole_to_ms};

const PROG_ID: &str = "Outlook.Application";
/// `olFolderCalendar`.
const CALENDAR_FOLDER: i32 = 9;
/// `olAppointmentItem` (`Items.Add`) and `olAppointment` (`Class`).
const APPOINTMENT_ITEM: i32 = 1;
const APPOINTMENT_CLASS: i64 = 26;
/// `olFree`, `olBusy`, `olPrivate`.
const FREE: i32 = 0;
const BUSY: i32 = 2;
const PRIVATE: i32 = 2;
/// The key in `PS_PUBLIC_STRINGS`; Microsoft Graph reads the same property as
/// `String {00020329-0000-0000-C000-000000000046} Name taskMasterKey` (ADR 030).
const KEY_PROPERTY: &str =
    "http://schemas.microsoft.com/mapi/string/{00020329-0000-0000-C000-000000000046}/taskMasterKey";
/// `MAPI_E_NOT_FOUND`.
const NOT_FOUND: i32 = 0x8004_010F_u32 as i32;
/// No calendar walk runs forever (a broken filter on an endless series).
const MAX_ITEMS: usize = 20_000;
const DAY_MS: i64 = 86_400_000;

pub const NOT_OPEN: &str = "Classic Outlook is not open: the calendar syncs while it runs.";

fn other(e: Error) -> ProviderError {
    if e.code.0 == NOT_FOUND {
        ProviderError::NotFound
    } else {
        ProviderError::Other(format!("Outlook: {e}"))
    }
}

/// A connection to Outlook on this thread.
pub struct Client {
    session: Dispatch,
    /// Pushed events of the target as last listed: EntryID → key.
    keyed: HashMap<String, String>,
    /// Dropped last: COM stays entered while the objects above live.
    _apartment: Apartment,
}

impl Client {
    /// Outlook if it runs, or started in the background when `may_start`.
    pub fn connect(may_start: bool) -> ProviderResult<Self> {
        let apartment = Apartment::enter().map_err(ProviderError::Other)?;
        let app = match Dispatch::running(PROG_ID).map_err(other)? {
            Some(app) => app,
            None if may_start => Dispatch::start(PROG_ID).map_err(other)?,
            None => return Err(ProviderError::Other(NOT_OPEN.into())),
        };
        let session = app
            .call("GetNamespace", &[Arg::Str("MAPI")])
            .and_then(|v| v.object("GetNamespace"))
            .map_err(other)?;
        Ok(Self {
            session,
            keyed: HashMap::new(),
            _apartment: apartment,
        })
    }

    fn default_folder(&self) -> Result<Dispatch, Error> {
        self.session
            .call("GetDefaultFolder", &[Arg::I4(CALENDAR_FOLDER)])?
            .object("GetDefaultFolder")
    }

    fn folder(&self, id: &str) -> ProviderResult<Dispatch> {
        self.session
            .call("GetFolderFromID", &[Arg::Str(id)])
            .and_then(|v| v.object("GetFolderFromID"))
            .map_err(other)
    }

    /// The mailbox the default calendar is in (for Settings).
    pub fn mailbox(&self) -> ProviderResult<String> {
        let folder = self.default_folder().map_err(other)?;
        Ok(store_name(&folder).unwrap_or_else(|| "Outlook".into()))
    }

    pub fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>> {
        let main = self.default_folder().map_err(other)?;
        let mailbox = store_name(&main);
        let mut calendars = vec![calendar(&main, true, mailbox.as_deref())?];
        // Calendars made inside the main one ("Calendar > Team").
        let subfolders = main.object("Folders").map_err(other)?;
        let count = subfolders.get("Count").map_err(other)?.int();
        for i in 1..=count {
            let folder = subfolders
                .get_with("Item", &[Arg::I4(i as i32)])
                .and_then(|v| v.object("Item"))
                .map_err(other)?;
            calendars.push(calendar(&folder, false, None)?);
        }
        Ok(calendars)
    }

    /// The target's pushed events changed since the last listing (`token`).
    pub fn changes(&mut self, calendar_id: &str, token: Option<&str>) -> ProviderResult<ChangeSet> {
        let previous = token.map(Seen::parse).transpose()?;
        let folder = self.folder(calendar_id)?;
        let current = match self.keyed_items(&folder) {
            Ok(items) => items,
            // Nothing pushed yet: a filter Outlook refuses loses nothing.
            Err(_) if previous.as_ref().is_none_or(|p| p.0.is_empty()) => Vec::new(),
            Err(e) => return Err(e),
        };
        let mut current = current;
        // An event missing from the listing is gone only if Outlook cannot find it in the
        // calendar either: a listing that misses items must not delete blocks.
        if let Some(previous) = &previous {
            for id in previous.0.keys() {
                if current.iter().any(|e| &e.id == id) {
                    continue;
                }
                if let Some(item) = self.item_in(calendar_id, id)? {
                    current.extend(self.read(&item, true)?);
                }
            }
        }
        self.keyed = current
            .iter()
            .filter_map(|e| e.key.clone().map(|k| (e.id.clone(), k)))
            .collect();
        let (events, seen) = model::changes(previous.as_ref(), current);
        Ok(ChangeSet {
            events,
            next_token: seen.token(),
        })
    }

    /// Items carrying the key: by a DASL filter, else by reading every item.
    fn keyed_items(&self, folder: &Dispatch) -> ProviderResult<Vec<RemoteEvent>> {
        let items = folder.object("Items").map_err(other)?;
        let filter = format!("@SQL=NOT(\"{KEY_PROPERTY}\" IS NULL)");
        let source = match items.call("Restrict", &[Arg::Str(&filter)]) {
            Ok(Value::Object(restricted)) => restricted,
            _ => items,
        };
        let mut events = Vec::new();
        walk(&source, |item| {
            events.extend(self.read(item, true)?);
            Ok(())
        })?;
        events.retain(|e| e.key.is_some());
        Ok(events)
    }

    /// The item with this event id, if it is still in that calendar (deleted items move
    /// to Deleted Items and keep their EntryID).
    fn item_in(&self, calendar_id: &str, id: &str) -> ProviderResult<Option<Dispatch>> {
        let item = match self
            .session
            .call("GetItemFromID", &[Arg::Str(entry_id(id))])
            .and_then(|v| v.object("GetItemFromID"))
        {
            Ok(item) => item,
            Err(e) if e.code.0 == NOT_FOUND => return Ok(None),
            Err(e) => return Err(other(e)),
        };
        let parent = item
            .object("Parent")
            .and_then(|p| p.get("EntryID"))
            .map_err(other)?
            .string();
        let here = self.folder(calendar_id)?;
        let same = self
            .session
            .call(
                "CompareEntryIDs",
                &[
                    Arg::Str(&parent),
                    Arg::Str(&here.get("EntryID").map_err(other)?.string()),
                ],
            )
            .map_err(other)?
            .bool();
        Ok(same.then_some(item))
    }

    pub fn events_between(
        &mut self,
        calendar_id: &str,
        from: i64,
        to: i64,
    ) -> ProviderResult<Vec<RemoteEvent>> {
        let folder = self.folder(calendar_id)?;
        let items = folder.object("Items").map_err(other)?;
        // Recurring meetings come expanded: sort by start, then include recurrences.
        items.call("Sort", &[Arg::Str("[Start]")]).map_err(other)?;
        items
            .put("IncludeRecurrences", Arg::Bool(true))
            .map_err(other)?;
        // Jet compares local wall times: a day of margin each side, then exact below.
        let filter = model::window_filter(&jet_date(from - DAY_MS)?, &jet_date(to + DAY_MS)?);
        let window = items
            .call("Restrict", &[Arg::Str(&filter)])
            .and_then(|v| v.object("Restrict"))
            .map_err(other)?;
        let mut events = Vec::new();
        walk(&window, |item| {
            events.extend(self.read(item, false)?);
            Ok(())
        })?;
        events.retain(|e| match &e.when {
            Some(When::Timed { start_at, end_at }) => *start_at < to && *end_at > from,
            _ => true,
        });
        Ok(events)
    }

    pub fn insert(&mut self, calendar_id: &str, body: &EventBody) -> ProviderResult<RemoteEvent> {
        let folder = self.folder(calendar_id)?;
        let item = folder
            .object("Items")
            .and_then(|items| items.call("Add", &[Arg::I4(APPOINTMENT_ITEM)]))
            .and_then(|v| v.object("Add"))
            .map_err(other)?;
        self.save(&item, body)
    }

    pub fn update(
        &mut self,
        calendar_id: &str,
        event_id: &str,
        body: &EventBody,
    ) -> ProviderResult<RemoteEvent> {
        let item = self
            .item_in(calendar_id, event_id)?
            .ok_or(ProviderError::NotFound)?;
        self.save(&item, body)
    }

    pub fn delete(&mut self, calendar_id: &str, event_id: &str) -> ProviderResult<()> {
        if let Some(item) = self.item_in(calendar_id, event_id)? {
            item.call("Delete", &[]).map_err(other)?;
        }
        self.keyed.remove(event_id);
        Ok(())
    }

    /// Shows an event in Outlook.
    pub fn display(&self, event_id: &str) -> ProviderResult<()> {
        let item = self
            .session
            .call("GetItemFromID", &[Arg::Str(entry_id(event_id))])
            .and_then(|v| v.object("GetItemFromID"))
            .map_err(other)?;
        item.call("Display", &[]).map_err(other)?;
        Ok(())
    }

    fn save(&mut self, item: &Dispatch, body: &EventBody) -> ProviderResult<RemoteEvent> {
        let set = |name: &str, value: Arg<'_>| item.put(name, value).map_err(other);
        set("Subject", Arg::Str(&body.title))?;
        match &body.when {
            When::Timed { start_at, end_at } => {
                set("AllDayEvent", Arg::Bool(false))?;
                set("StartUTC", Arg::Date(ms_to_ole(*start_at)))?;
                set("EndUTC", Arg::Date(ms_to_ole(*end_at)))?;
                set("BusyStatus", Arg::I4(BUSY))?;
            }
            When::AllDay { start, end } => {
                set("AllDayEvent", Arg::Bool(true))?;
                set("Start", Arg::Date(date_ole(start)?))?;
                set("End", Arg::Date(date_ole(end)?))?;
                set("BusyStatus", Arg::I4(FREE))?;
            }
        }
        // The main calendar is visible to colleagues: titles stay private, and no
        // reminder pops up for every block.
        set("Sensitivity", Arg::I4(PRIVATE))?;
        set("ReminderSet", Arg::Bool(false))?;
        item.object("PropertyAccessor")
            .and_then(|p| {
                p.call(
                    "SetProperty",
                    &[Arg::Str(KEY_PROPERTY), Arg::Str(&body.key)],
                )
            })
            .map_err(other)?;
        item.call("Save", &[]).map_err(other)?;
        let mut event = self
            .read(item, true)?
            .ok_or_else(|| ProviderError::Other("Outlook did not save the event".into()))?;
        event.key = Some(body.key.clone());
        self.keyed.insert(event.id.clone(), body.key.clone());
        Ok(event)
    }

    /// An appointment as the engine sees it (`None` for other kinds of items). `exact`
    /// reads the key and the change time in UTC (two more calls per item).
    fn read(&self, item: &Dispatch, exact: bool) -> ProviderResult<Option<RemoteEvent>> {
        let get = |name: &str| item.get(name).map_err(other);
        if get("Class")?.int() != APPOINTMENT_CLASS {
            return Ok(None);
        }
        let entry = get("EntryID")?.string();
        let all_day = get("AllDayEvent")?.bool();
        let date = |name: &str| -> ProviderResult<f64> {
            get(name)?
                .number()
                .ok_or_else(|| ProviderError::Other(format!("Outlook: no {name} on an event")))
        };
        let when = if all_day {
            When::AllDay {
                start: ole_date(date("Start")?),
                end: ole_date(date("End")?),
            }
        } else {
            When::Timed {
                start_at: ole_to_ms(date("StartUTC")?),
                end_at: ole_to_ms(date("EndUTC")?),
            }
        };
        let occurrence = get("RecurrenceState")?.int() != 0;
        let id = event_id(
            &entry,
            occurrence.then(|| match &when {
                When::Timed { start_at, .. } => *start_at,
                When::AllDay { start, .. } => date_ole(start).map(ole_to_ms).unwrap_or_default(),
            }),
        );
        let modified = date("LastModificationTime")?;
        let (key, updated) = if exact && !occurrence {
            let accessor = item.object("PropertyAccessor").map_err(other)?;
            let key = accessor
                .call("GetProperty", &[Arg::Str(KEY_PROPERTY)])
                .ok()
                .map(Value::string)
                .filter(|k| !k.is_empty());
            let utc = accessor
                .call("LocalTimeToUTC", &[Arg::Date(modified)])
                .map_err(other)?
                .number()
                .unwrap_or(modified);
            (key, ole_to_ms(utc))
        } else {
            (
                (!occurrence)
                    .then(|| self.keyed.get(&entry).cloned())
                    .flatten(),
                ole_to_ms(modified),
            )
        };
        let location = get("Location")?.string();
        Ok(Some(RemoteEvent {
            id,
            cancelled: false,
            title: get("Subject")?.string(),
            when: Some(when),
            updated,
            key,
            location: (!location.trim().is_empty()).then_some(location),
            link: None,
        }))
    }
}

fn store_name(folder: &Dispatch) -> Option<String> {
    folder
        .object("Store")
        .and_then(|s| s.get("DisplayName"))
        .ok()
        .map(Value::string)
        .filter(|s| !s.is_empty())
}

fn calendar(
    folder: &Dispatch,
    primary: bool,
    mailbox: Option<&str>,
) -> ProviderResult<RemoteCalendar> {
    let name = folder.get("Name").map_err(other)?.string();
    Ok(RemoteCalendar {
        id: folder.get("EntryID").map_err(other)?.string(),
        name: match mailbox {
            Some(m) => format!("{name} ({m})"),
            None => name,
        },
        color: None,
        primary,
        owned: true,
    })
}

/// Every item of a collection, with `GetFirst`/`GetNext` (`Count` is unreliable once
/// recurrences are included).
fn walk(
    items: &Dispatch,
    mut each: impl FnMut(&Dispatch) -> ProviderResult<()>,
) -> ProviderResult<()> {
    let mut next = items.call("GetFirst", &[]).map_err(other)?;
    let mut n = 0;
    while let Value::Object(item) = next {
        each(&item)?;
        n += 1;
        if n >= MAX_ITEMS {
            break;
        }
        next = items.call("GetNext", &[]).map_err(other)?;
    }
    Ok(())
}

/// A wall date for Jet filters, in the user's short date format.
fn jet_date(ms: i64) -> ProviderResult<String> {
    let iso = taskmaster_core::utc_date(ms);
    let mut parts = iso.splitn(3, '-').map(|p| p.parse::<u16>().unwrap_or(1));
    let (y, m, d) = (
        parts.next().unwrap_or(1970),
        parts.next().unwrap_or(1),
        parts.next().unwrap_or(1),
    );
    short_date(y, m, d).map_err(ProviderError::Other)
}
