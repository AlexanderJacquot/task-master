use std::collections::BTreeMap;
use taskmaster_core::calendar::*;

/// A calendar server: events per calendar, with a change counter for sync tokens.
#[derive(Default)]
pub struct FakeServer {
    pub before_calendars: Option<Box<dyn FnMut() + Send>>,
    pub calendars: Vec<RemoteCalendar>,
    /// calendar -> event id -> (event, version of its last change)
    pub events: BTreeMap<String, BTreeMap<String, (RemoteEvent, u64)>>,
    pub version: u64,
    pub next_id: u64,
    pub expire_token: bool,
    pub writes: Vec<String>,
}

impl FakeServer {
    pub fn with_primary() -> Self {
        let mut server = Self::default();
        server.calendars.push(RemoteCalendar {
            id: "me@example.com".into(),
            name: "me@example.com".into(),
            color: Some("#0b8043".into()),
            primary: true,
            owned: true,
        });
        server
    }

    pub fn bump(&mut self) -> u64 {
        self.version += 1;
        self.version
    }

    pub fn target(&self) -> String {
        self.calendars
            .iter()
            .find(|c| c.name == TARGET_CALENDAR)
            .map(|c| c.id.clone())
            .expect("target calendar created")
    }

    pub fn live(&self, calendar: &str) -> Vec<RemoteEvent> {
        self.events
            .get(calendar)
            .map(|m| {
                m.values()
                    .map(|(e, _)| e.clone())
                    .filter(|e| !e.cancelled)
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn event(&self, calendar: &str, id: &str) -> RemoteEvent {
        self.events[calendar][id].0.clone()
    }

    /// An edit made in the calendar app by the user.
    pub fn user_edit(&mut self, calendar: &str, id: &str, edit: impl FnOnce(&mut RemoteEvent)) {
        let v = self.bump();
        let entry = self.events.get_mut(calendar).unwrap().get_mut(id).unwrap();
        edit(&mut entry.0);
        entry.0.updated = 2_000_000_000_000 + v as i64;
        entry.1 = v;
    }

    pub fn user_add(&mut self, calendar: &str, title: &str, when: When) -> String {
        self.next_id += 1;
        let id = format!("u{}", self.next_id);
        let v = self.bump();
        let event = RemoteEvent {
            id: id.clone(),
            cancelled: false,
            title: title.into(),
            when: Some(when),
            updated: 2_000_000_000_000 + v as i64,
            key: None,
            location: None,
            link: Some(format!("https://calendar.example/{id}")),
        };
        self.events
            .entry(calendar.into())
            .or_default()
            .insert(id.clone(), (event, v));
        id
    }

    pub fn put(&mut self, calendar: &str, id: String, body: &EventBody) -> RemoteEvent {
        let v = self.bump();
        let event = RemoteEvent {
            id: id.clone(),
            cancelled: false,
            title: body.title.clone(),
            when: Some(body.when.clone()),
            updated: 1_000_000_000_000 + v as i64,
            key: Some(body.key.clone()),
            location: None,
            link: None,
        };
        self.events
            .entry(calendar.into())
            .or_default()
            .insert(id, (event.clone(), v));
        event
    }
}

impl CalendarProvider for FakeServer {
    fn calendars(&mut self) -> ProviderResult<Vec<RemoteCalendar>> {
        if let Some(before) = &mut self.before_calendars {
            before();
        }
        Ok(self.calendars.clone())
    }

    fn create_calendar(&mut self, name: &str) -> ProviderResult<RemoteCalendar> {
        self.writes.push(format!("create_calendar {name}"));
        let calendar = RemoteCalendar {
            id: format!("cal-{}", self.calendars.len()),
            name: name.into(),
            color: None,
            primary: false,
            owned: true,
        };
        self.calendars.push(calendar.clone());
        Ok(calendar)
    }

    fn changes(&mut self, calendar_id: &str, token: Option<&str>) -> ProviderResult<ChangeSet> {
        if token.is_some() && std::mem::take(&mut self.expire_token) {
            return Err(ProviderError::TokenExpired);
        }
        let since: u64 = token.map_or(0, |t| t.parse().unwrap());
        let events = self
            .events
            .get(calendar_id)
            .map(|m| {
                m.values()
                    .filter(|(e, v)| *v > since && (token.is_some() || !e.cancelled))
                    .map(|(e, _)| e.clone())
                    .collect()
            })
            .unwrap_or_default();
        Ok(ChangeSet {
            events,
            next_token: self.version.to_string(),
        })
    }

    fn events_between(
        &mut self,
        calendar_id: &str,
        from: i64,
        to: i64,
    ) -> ProviderResult<Vec<RemoteEvent>> {
        Ok(self
            .live(calendar_id)
            .into_iter()
            .filter(|e| match &e.when {
                Some(When::Timed { start_at, end_at }) => *start_at < to && *end_at > from,
                _ => true,
            })
            .collect())
    }

    fn insert(&mut self, calendar_id: &str, body: &EventBody) -> ProviderResult<RemoteEvent> {
        self.writes.push(format!("insert {}", body.key));
        self.next_id += 1;
        let id = format!("e{}", self.next_id);
        Ok(self.put(calendar_id, id, body))
    }

    fn update(
        &mut self,
        calendar_id: &str,
        event_id: &str,
        body: &EventBody,
    ) -> ProviderResult<RemoteEvent> {
        self.writes.push(format!("update {}", body.key));
        let exists = self
            .events
            .get(calendar_id)
            .and_then(|m| m.get(event_id))
            .is_some_and(|(e, _)| !e.cancelled);
        if !exists {
            return Err(ProviderError::NotFound);
        }
        Ok(self.put(calendar_id, event_id.into(), body))
    }

    fn delete(&mut self, calendar_id: &str, event_id: &str) -> ProviderResult<()> {
        self.writes.push(format!("delete {event_id}"));
        let v = self.bump();
        if let Some((event, version)) = self
            .events
            .get_mut(calendar_id)
            .and_then(|m| m.get_mut(event_id))
        {
            event.cancelled = true;
            *version = v;
        }
        Ok(())
    }
}
