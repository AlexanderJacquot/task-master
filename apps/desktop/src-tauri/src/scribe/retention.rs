//! When a meeting's audio is deleted (ADR 025, pure): all audio expires, a number of days
//! (Settings → Scribe) after the transcript is validated, or after it was made when it is
//! never validated. A deleted meeting's audio goes that long after the deletion, so undo
//! still finds it. A recording never transcribed is kept until it is.

use taskmaster_core::{Meeting, Timestamp};

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;
pub const DEFAULT_DAYS: u32 = 10;

/// When this meeting's audio is to be deleted; `None` to keep it.
pub fn purge_at(meeting: &Meeting, days: u32) -> Option<Timestamp> {
    let start = meeting
        .deleted_at
        .or(meeting.validated_at)
        .or(meeting.transcribed_at)?;
    Some(start + i64::from(days) * DAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use taskmaster_core::MeetingState;

    fn meeting() -> Meeting {
        Meeting {
            id: "m".into(),
            title: "M".into(),
            started_at: 0,
            ended_at: Some(1),
            project_id: None,
            epic_id: None,
            task_id: None,
            state: MeetingState::Held,
            participants: Vec::new(),
            notes: String::new(),
            summary: None,
            transcribed_at: None,
            validated_at: None,
            speakers: Default::default(),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    #[test]
    fn audio_expires_after_validation_or_after_the_transcript() {
        let mut m = meeting();
        assert_eq!(purge_at(&m, 10), None);
        m.transcribed_at = Some(1_000);
        assert_eq!(purge_at(&m, 10), Some(1_000 + 10 * DAY_MS));
        m.validated_at = Some(5_000);
        assert_eq!(purge_at(&m, 3), Some(5_000 + 3 * DAY_MS));
        m.deleted_at = Some(9_000);
        assert_eq!(purge_at(&m, 10), Some(9_000 + 10 * DAY_MS));
        // Deleted before any transcript: still expires.
        let mut never = meeting();
        never.deleted_at = Some(2_000);
        assert_eq!(purge_at(&never, 1), Some(2_000 + DAY_MS));
    }
}
