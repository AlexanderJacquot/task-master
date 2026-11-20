//! Outside Windows: the same calls, each failing with [`crate::UNAVAILABLE`].

use taskmaster_core::calendar::{
    ChangeSet, EventBody, ProviderError, ProviderResult, RemoteCalendar, RemoteEvent,
};

fn unavailable<T>() -> ProviderResult<T> {
    Err(ProviderError::Other(crate::UNAVAILABLE.into()))
}

pub struct Client;

impl Client {
    pub fn connect(_may_start: bool) -> ProviderResult<Self> {
        unavailable()
    }
    pub fn mailbox(&self) -> ProviderResult<String> {
        unavailable()
    }
    pub fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>> {
        unavailable()
    }
    pub fn changes(&mut self, _: &str, _: Option<&str>) -> ProviderResult<ChangeSet> {
        unavailable()
    }
    pub fn events_between(&mut self, _: &str, _: i64, _: i64) -> ProviderResult<Vec<RemoteEvent>> {
        unavailable()
    }
    pub fn insert(&mut self, _: &str, _: &EventBody) -> ProviderResult<RemoteEvent> {
        unavailable()
    }
    pub fn update(&mut self, _: &str, _: &str, _: &EventBody) -> ProviderResult<RemoteEvent> {
        unavailable()
    }
    pub fn delete(&mut self, _: &str, _: &str) -> ProviderResult<()> {
        unavailable()
    }
    pub fn display(&self, _: &str) -> ProviderResult<()> {
        unavailable()
    }
}
