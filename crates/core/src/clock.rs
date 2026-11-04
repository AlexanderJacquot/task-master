//! Identity and time: UUIDv7 ids, Unix-ms timestamps, ISO dates and the hybrid logical clock.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};

/// A new UUIDv7: sortable by creation time and safe to merge across devices.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Accepts a client-provided id (the UI generates ids for optimistic writes).
pub(crate) fn check_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| Error::invalid(format!("'{id}' is not a valid UUID")))
}

/// Current time in Unix milliseconds, UTC.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Checks a calendar date is a real `YYYY-MM-DD` date.
pub(crate) fn check_date(field: &str, value: &str) -> Result<()> {
    let bad = || Error::invalid(format!("{field} must be a YYYY-MM-DD date, got '{value}'"));
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return Err(bad());
    }
    let num = |range: std::ops::Range<usize>| -> Result<u32> {
        let s = &value[range];
        if s.bytes().all(|c| c.is_ascii_digit()) {
            s.parse().map_err(|_| bad())
        } else {
            Err(bad())
        }
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(bad()),
    };
    if day == 0 || day > days_in_month {
        return Err(bad());
    }
    Ok(())
}

/// Hybrid logical clock: wall time + counter + device.
///
/// Encoded as `{wall_ms:013}-{counter:05}-{device_id}` so string order is clock order.
/// It costs nothing now and enables field-level last-writer-wins sync later.
#[derive(Debug, Clone)]
pub(crate) struct Hlc {
    wall: i64,
    counter: u32,
    device_id: String,
}

impl Hlc {
    /// Starts after `last_seen` (the highest HLC already stored), if any.
    pub(crate) fn new(device_id: String, last_seen: Option<&str>) -> Self {
        let (wall, counter) = last_seen.and_then(Self::parse).unwrap_or((0, 0));
        Self {
            wall,
            counter,
            device_id,
        }
    }

    fn parse(hlc: &str) -> Option<(i64, u32)> {
        let mut parts = hlc.splitn(3, '-');
        let wall = parts.next()?.parse().ok()?;
        let counter = parts.next()?.parse().ok()?;
        Some((wall, counter))
    }

    /// Next timestamp, strictly greater than every previous one from this clock.
    pub(crate) fn tick(&mut self, now: i64) -> String {
        if now > self.wall {
            self.wall = now;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        format!("{:013}-{:05}-{}", self.wall, self.counter, self.device_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        for ok in ["2026-11-04", "2024-02-29", "2000-02-29", "1999-12-31"] {
            assert!(check_date("d", ok).is_ok(), "{ok}");
        }
        for bad in [
            "2026-2-04",
            "2026-13-01",
            "2026-00-10",
            "2026-04-31",
            "2023-02-29",
            "1900-02-29",
            "2026-11-04T10:00",
            "abcd-ef-gh",
            "",
        ] {
            assert!(check_date("d", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn hlc_is_monotonic_even_if_wall_clock_goes_back() {
        let mut clock = Hlc::new("dev".into(), None);
        let a = clock.tick(1_000);
        let b = clock.tick(1_000);
        let c = clock.tick(500);
        let d = clock.tick(2_000);
        assert!(a < b && b < c && c < d, "{a} {b} {c} {d}");
    }

    #[test]
    fn hlc_resumes_after_last_seen() {
        let mut first = Hlc::new("dev".into(), None);
        let stored = first.tick(5_000);
        let mut resumed = Hlc::new("dev".into(), Some(&stored));
        assert!(resumed.tick(1_000) > stored);
    }

    #[test]
    fn ids() {
        let id = new_id();
        assert!(check_id(&id).is_ok());
        assert!(check_id("nope").is_err());
        assert!(new_id() > id, "UUIDv7 sorts by creation time");
    }
}
