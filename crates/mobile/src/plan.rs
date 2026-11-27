//! Time blocks (the day plan) and what local notifications the phone schedules. iOS
//! fires the notifications itself; the app asks for the coming ones after each change.

use taskmaster_core::{
    BlockOutcome, Command, NewTimeBlock, Snapshot, TimeBlock, TimeBlockChange, Timestamp,
};

use crate::team::Data;
use crate::{AppError, AppResult, Core, Day, is_mine_open};

pub(crate) const MINUTE_MS: i64 = 60_000;
pub(crate) const DAY_MS: i64 = 24 * 60 * MINUTE_MS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Outcome {
    Planned,
    Done,
    /// Worked on, not finished.
    Worked,
    Missed,
    Cancelled,
}

impl From<BlockOutcome> for Outcome {
    fn from(o: BlockOutcome) -> Self {
        match o {
            BlockOutcome::Planned => Self::Planned,
            BlockOutcome::Done => Self::Done,
            BlockOutcome::Worked => Self::Worked,
            BlockOutcome::Missed => Self::Missed,
            BlockOutcome::Cancelled => Self::Cancelled,
        }
    }
}

impl From<Outcome> for BlockOutcome {
    fn from(o: Outcome) -> Self {
        match o {
            Outcome::Planned => Self::Planned,
            Outcome::Done => Self::Done,
            Outcome::Worked => Self::Worked,
            Outcome::Missed => Self::Missed,
            Outcome::Cancelled => Self::Cancelled,
        }
    }
}

/// A time block with its task's title and color.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct BlockItem {
    pub id: String,
    pub task_id: String,
    pub title: String,
    pub project_color: Option<String>,
    /// Unix ms.
    pub start_at: i64,
    pub end_at: i64,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ReminderKind {
    /// The task is due that day.
    Due,
    /// A planned time block starts.
    Block,
}

/// A local notification to schedule.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Reminder {
    /// Stable while the reminder means the same thing (`due:<task>:<date>`,
    /// `block:<id>:<start>`): reschedule by replacing the set, matching on this.
    pub key: String,
    pub task_id: String,
    pub title: String,
    /// When it fires, Unix ms.
    pub at: i64,
    pub kind: ReminderKind,
}

pub(crate) fn block_item(block: &TimeBlock, s: &Snapshot) -> BlockItem {
    let task = s.tasks.iter().find(|t| t.id == block.task_id);
    BlockItem {
        id: block.id.clone(),
        task_id: block.task_id.clone(),
        title: task.map(|t| t.title.clone()).unwrap_or_default(),
        project_color: task
            .and_then(|t| t.project_id.as_deref())
            .and_then(|id| s.projects.iter().find(|p| p.id == id))
            .and_then(|p| p.color.clone()),
        start_at: block.start_at,
        end_at: block.end_at,
        outcome: block.outcome.into(),
    }
}

/// Whether a task reminds this person: their own open tasks, and open team tasks
/// assigned to them (a teammate's work does not ring on this phone).
fn reminds(task: &taskmaster_core::Task, s: &Data) -> bool {
    is_mine_open(task, s)
        && (!s.is_team(&task.id)
            || task.assignee_id.is_some() && task.assignee_id.as_deref() == s.me())
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` date (proleptic Gregorian).
pub(crate) fn days_from_civil(date: &str) -> Option<i64> {
    let mut parts = date.split('-');
    let (y, m, d): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// The start of `date` on the phone, in Unix ms, for the offset in `day`. A day on which
/// the offset changes (daylight saving) is off by that hour at its start; the app asks
/// again once the day begins.
pub(crate) fn local_midnight(date: &str, day: &Day) -> AppResult<Timestamp> {
    let days = days_from_civil(date).ok_or_else(|| AppError::Invalid {
        message: format!("{date} is not a date (YYYY-MM-DD)"),
    })?;
    Ok(days * DAY_MS - i64::from(day.utc_offset_min) * MINUTE_MS)
}

fn check_span(start_at: i64, end_at: i64) -> AppResult<()> {
    if end_at <= start_at {
        return Err(AppError::Invalid {
            message: "a block must end after it starts".into(),
        });
    }
    Ok(())
}

#[uniffi::export]
impl Core {
    /// The blocks on a day (`YYYY-MM-DD`, the phone's day), by start; one that crosses
    /// midnight shows on both days.
    pub fn day_blocks(&self, date: String, day: Day) -> AppResult<Vec<BlockItem>> {
        let start = local_midnight(&date, &day)?;
        let end = start + DAY_MS;
        let s = self.inner.data()?;
        Ok(s.time_blocks
            .iter()
            .filter(|b| b.start_at < end && b.end_at > start)
            .map(|b| block_item(b, &s))
            .collect())
    }

    /// Plans time for a task. Times are Unix ms. Returns the block's id.
    pub fn schedule(&self, task_id: String, start_at: i64, end_at: i64) -> AppResult<String> {
        check_span(start_at, end_at)?;
        let id = taskmaster_core::new_id();
        self.inner.execute(
            vec![Command::CreateTimeBlock {
                block: NewTimeBlock {
                    id: Some(id.clone()),
                    task_id,
                    start_at,
                    end_at,
                    outcome: None,
                },
            }],
            None,
        )?;
        Ok(id)
    }

    /// Moves or resizes a block.
    pub fn move_block(&self, id: String, start_at: i64, end_at: i64) -> AppResult<()> {
        check_span(start_at, end_at)?;
        self.inner.execute(
            vec![Command::UpdateTimeBlock {
                id,
                changes: vec![
                    TimeBlockChange::StartAt(start_at),
                    TimeBlockChange::EndAt(end_at),
                ],
            }],
            None,
        )?;
        Ok(())
    }

    /// Records how a block went.
    pub fn set_block_outcome(&self, id: String, outcome: Outcome) -> AppResult<()> {
        self.inner.execute(
            vec![Command::UpdateTimeBlock {
                id,
                changes: vec![TimeBlockChange::Outcome(outcome.into())],
            }],
            None,
        )?;
        Ok(())
    }

    /// Removes a block from the plan.
    pub fn unschedule(&self, id: String) -> AppResult<()> {
        self.inner
            .execute(vec![Command::DeleteTimeBlock { id }], None)?;
        Ok(())
    }

    /// The notifications that fire in `[from, to)` (Unix ms), by time: open tasks due on
    /// a day, at `due_minute` minutes after that day's midnight, and planned blocks of
    /// open tasks at their start (blocks are this person's plan, on team tasks too).
    /// Agent tasks never remind; a team task's due date only reminds its assignee.
    pub fn reminders(
        &self,
        from: i64,
        to: i64,
        due_minute: u32,
        day: Day,
    ) -> AppResult<Vec<Reminder>> {
        let s = self.inner.data()?;
        let mut out = Vec::new();
        for task in s.tasks.iter().filter(|t| reminds(t, &s)) {
            let Some(due) = task.due_date.as_deref() else {
                continue;
            };
            let Ok(midnight) = local_midnight(due, &day) else {
                continue;
            };
            let at = midnight + i64::from(due_minute) * MINUTE_MS;
            if (from..to).contains(&at) {
                out.push(Reminder {
                    key: format!("due:{}:{due}", task.id),
                    task_id: task.id.clone(),
                    title: task.title.clone(),
                    at,
                    kind: ReminderKind::Due,
                });
            }
        }
        for block in &s.time_blocks {
            let open = s
                .tasks
                .iter()
                .find(|t| t.id == block.task_id)
                .filter(|t| is_mine_open(t, &s));
            let Some(task) = open else { continue };
            if block.outcome == BlockOutcome::Planned && (from..to).contains(&block.start_at) {
                out.push(Reminder {
                    key: format!("block:{}:{}", block.id, block.start_at),
                    task_id: task.id.clone(),
                    title: task.title.clone(),
                    at: block.start_at,
                    kind: ReminderKind::Block,
                });
            }
        }
        out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.key.cmp(&b.key)));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_days() {
        assert_eq!(days_from_civil("1970-01-01"), Some(0));
        assert_eq!(days_from_civil("2000-03-01"), Some(11_017));
        assert_eq!(days_from_civil("2026-11-20"), Some(20_777));
        assert_eq!(days_from_civil("2026-13-01"), None);
        assert_eq!(days_from_civil("2026-11"), None);
    }

    #[test]
    fn midnight_follows_the_offset() {
        let day = Day {
            today: "2026-11-20".into(),
            utc_offset_min: 60,
        };
        // 2026-11-20 00:00 at UTC+1 is 2026-11-19 23:00 UTC.
        assert_eq!(
            local_midnight("2026-11-20", &day).unwrap(),
            20_777 * DAY_MS - 60 * MINUTE_MS
        );
    }
}
