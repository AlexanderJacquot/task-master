//! Classic Outlook's calendar as a [`CalendarProvider`] (ADR 030): on Windows, through
//! Outlook's COM object model, so the account Outlook is already signed in to (a work account included) is
//! used as is (no sign-in, no app registration, no tenant consent). Pushed events go to
//! the main calendar ([`CalendarProvider::target_is_primary`]).
//!
//! Elsewhere every call fails with [`UNAVAILABLE`]; [`available`] says which.

pub mod model;

#[cfg(windows)]
mod com;
#[cfg(windows)]
mod outlook;
#[cfg(not(windows))]
#[path = "stub.rs"]
mod outlook;

use taskmaster_core::calendar::{
    CalendarProvider, ChangeSet, EventBody, ProviderError, ProviderResult, RemoteCalendar,
    RemoteEvent,
};

pub const UNAVAILABLE: &str = "Classic Outlook is only on Windows.";

/// Whether this build can reach classic Outlook.
pub fn available() -> bool {
    cfg!(windows)
}

/// The calendar of classic Outlook. Not `Send` on Windows: COM objects stay on the thread
/// that made them (the calendar sync thread).
#[derive(Default)]
pub struct OutlookCalendar {
    client: Option<outlook::Client>,
    may_start: bool,
}

impl OutlookCalendar {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether a sync may start Outlook when it is not running ("Sync now"); background
    /// syncs only use an Outlook that is already open.
    pub fn set_may_start(&mut self, may_start: bool) {
        self.may_start = may_start;
    }

    fn with<T>(
        &mut self,
        f: impl FnOnce(&mut outlook::Client) -> ProviderResult<T>,
    ) -> ProviderResult<T> {
        if self.client.is_none() {
            self.client = Some(outlook::Client::connect(self.may_start)?);
        }
        let client = self.client.as_mut().expect("connected above");
        let result = f(client);
        // Outlook closed or the call broke: connect again next time.
        if matches!(result, Err(ProviderError::Other(_))) {
            self.client = None;
        }
        result
    }
}

impl CalendarProvider for OutlookCalendar {
    fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>> {
        // The first call of a sync: an Outlook that was closed since is reconnected once.
        match self.with(|c| c.calendars()) {
            Err(ProviderError::Other(_)) if available() => self.with(|c| c.calendars()),
            other => other,
        }
    }

    fn create_calendar(&mut self, _name: &str) -> ProviderResult<RemoteCalendar> {
        Err(ProviderError::Other(
            "Outlook syncs with the main calendar; it creates no calendar".into(),
        ))
    }

    fn changes(&mut self, calendar_id: &str, token: Option<&str>) -> ProviderResult<ChangeSet> {
        self.with(|c| c.changes(calendar_id, token))
    }

    fn events_between(
        &mut self,
        calendar_id: &str,
        from: i64,
        to: i64,
    ) -> ProviderResult<Vec<RemoteEvent>> {
        self.with(|c| c.events_between(calendar_id, from, to))
    }

    fn insert(&mut self, calendar_id: &str, body: &EventBody) -> ProviderResult<RemoteEvent> {
        self.with(|c| c.insert(calendar_id, body))
    }

    fn update(
        &mut self,
        calendar_id: &str,
        event_id: &str,
        body: &EventBody,
    ) -> ProviderResult<RemoteEvent> {
        self.with(|c| c.update(calendar_id, event_id, body))
    }

    fn delete(&mut self, calendar_id: &str, event_id: &str) -> ProviderResult<()> {
        self.with(|c| c.delete(calendar_id, event_id))
    }

    fn target_is_primary(&self) -> bool {
        true
    }
}

/// Reaches Outlook (starting it if needed) and names the mailbox of its main calendar.
/// Runs on a thread of its own, so the caller's thread keeps its COM state.
pub fn check() -> Result<String, String> {
    on_own_thread(|| {
        outlook::Client::connect(true)
            .and_then(|c| c.mailbox())
            .map_err(message)
    })
}

/// Opens an event in Outlook.
pub fn open_event(event_id: String) -> Result<(), String> {
    on_own_thread(move || {
        outlook::Client::connect(true)
            .and_then(|c| c.display(&event_id))
            .map_err(message)
    })
}

fn message(e: ProviderError) -> String {
    match e {
        ProviderError::Other(m) | ProviderError::Auth(m) => m,
        ProviderError::NotFound => "Outlook could not find it".into(),
        ProviderError::TokenExpired => "Outlook: start over".into(),
    }
}

fn on_own_thread<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    std::thread::spawn(f)
        .join()
        .unwrap_or_else(|_| Err("the Outlook call failed".into()))
}
