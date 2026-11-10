//! Views: the rows of a list and the cells of a board, as pure functions of a
//! [`Snapshot`] and a [`ViewSpec`] (plan section 5, ADR 022).
//!
//! The desktop evaluates views in TypeScript (`apps/desktop/src/lib/views.ts` and
//! `board.ts`); front ends without that code (the phone, later the API and the CLI) ask
//! the core. Both implementations pass `test-vectors/views.json`.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::commands::TaskChange;
use crate::model::{
    DueFilter, Epic, FILTER_NONE, GroupBy, Id, IsoDate, Priority, Project, Snapshot, SortBy,
    Status, StatusCategory, Swimlane, Task, TaskOwner, ViewFilter, ViewScope, ViewSpec,
};
use crate::parse::dates;

/// What a view depends on besides the spec and the data.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewOptions {
    /// The user's calendar date.
    pub today: IsoDate,
    /// Minutes east of UTC, to tell which tasks were closed today (boards only).
    #[serde(default)]
    pub utc_offset_min: i32,
    /// Group keys shown as a header only (lists only).
    #[serde(default)]
    pub collapsed_groups: Vec<String>,
    /// Tasks whose subtasks are hidden (lists only).
    #[serde(default)]
    pub collapsed_tasks: Vec<Id>,
}

/// A heading in a list. `key` is stable within a grouping: a status, project or epic id,
/// a priority, a due bucket, or `none`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewGroup {
    pub key: String,
    pub label: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ViewRow {
    Group {
        group: ViewGroup,
        /// Top-level rows in the group.
        count: u32,
        collapsed: bool,
    },
    Task {
        task: Box<Task>,
        /// 0, or 1 for a subtask under its parent.
        depth: u8,
        /// Subtask progress over all live children.
        child_count: u32,
        child_done: u32,
        /// Children shown under this row in the view.
        visible_children: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardCard {
    pub task: Task,
    pub child_count: u32,
    pub child_done: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardColumn {
    pub status: Status,
    /// Cards in the column over every lane.
    pub count: u32,
    pub over_limit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BoardLane {
    /// `all`, or `project:<id|none>`, `epic:<id|none>`, `priority:<value>`.
    pub key: String,
    pub label: String,
    pub color: Option<String>,
    /// What a card dropped into this lane takes (none for the single `all` lane).
    pub changes: Vec<TaskChange>,
    /// One cell per column, in column order; cards in rank order.
    pub cells: Vec<Vec<BoardCard>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Board {
    pub columns: Vec<BoardColumn>,
    pub lanes: Vec<BoardLane>,
}

struct Ctx<'a> {
    today: &'a str,
    today_days: i64,
    utc_offset_min: i32,
    statuses: HashMap<&'a str, &'a Status>,
    projects: HashMap<&'a str, &'a Project>,
    epics: HashMap<&'a str, &'a Epic>,
}

impl<'a> Ctx<'a> {
    fn new(snapshot: &'a Snapshot, options: &'a ViewOptions) -> Self {
        Self {
            today: &options.today,
            today_days: dates::to_days(&options.today).unwrap_or(0),
            utc_offset_min: options.utc_offset_min,
            statuses: snapshot
                .statuses
                .iter()
                .map(|s| (s.id.as_str(), s))
                .collect(),
            projects: snapshot
                .projects
                .iter()
                .map(|p| (p.id.as_str(), p))
                .collect(),
            epics: snapshot.epics.iter().map(|e| (e.id.as_str(), e)).collect(),
        }
    }

    fn category(&self, task: &Task) -> StatusCategory {
        self.statuses
            .get(task.status_id.as_str())
            .map_or(StatusCategory::Todo, |s| s.category)
    }

    fn is_open(&self, task: &Task) -> bool {
        !matches!(
            self.category(task),
            StatusCategory::Done | StatusCategory::Cancelled
        )
    }

    fn is_overdue(&self, task: &Task) -> bool {
        task.due_date.as_deref().is_some_and(|due| due < self.today) && self.is_open(task)
    }

    /// Done or cancelled on the user's today (cancelled tasks have no `completed_at`).
    fn closed_today(&self, task: &Task) -> bool {
        if self.is_open(task) {
            return false;
        }
        let at = task.completed_at.unwrap_or(task.updated_at);
        let local = at + i64::from(self.utc_offset_min) * 60_000;
        local.div_euclid(86_400_000) == self.today_days
    }

    /// Whole days from today to `iso` (negative = past).
    fn days_until(&self, iso: &str) -> i64 {
        dates::to_days(iso).unwrap_or(self.today_days) - self.today_days
    }

    fn in_scope(&self, scope: &ViewScope, task: &Task, keep_closed_today: bool) -> bool {
        let open = || self.is_open(task) || (keep_closed_today && self.closed_today(task));
        match scope {
            ViewScope::Inbox => task.project_id.is_none() && open(),
            // Picked for today (even once done), or due today or earlier and still open.
            ViewScope::Today => {
                task.today_on.as_deref() == Some(self.today)
                    || (task.due_date.as_deref().is_some_and(|d| d <= self.today) && open())
            }
            ViewScope::All => true,
            // An area shows the tasks of the projects inside it.
            ViewScope::Project { id } => task.project_id.as_deref().is_some_and(|p| {
                p == id
                    || self
                        .projects
                        .get(p)
                        .is_some_and(|project| project.parent_id.as_deref() == Some(id.as_str()))
            }),
            ViewScope::Epic { id } => task.epic_id.as_deref() == Some(id.as_str()),
            ViewScope::Tag { id } => task.tag_ids.contains(id),
        }
    }

    fn matches_due(&self, due: DueFilter, task: &Task) -> bool {
        match due {
            DueFilter::Overdue => self.is_overdue(task),
            DueFilter::Today => task.due_date.as_deref().is_some_and(|d| d <= self.today),
            DueFilter::Week => task
                .due_date
                .as_deref()
                .is_some_and(|d| self.days_until(d) <= 7),
            DueFilter::None => task.due_date.is_none(),
        }
    }

    fn matches_filter(&self, filter: &ViewFilter, task: &Task) -> bool {
        let has = |list: &[Id], value: &str| list.iter().any(|v| v == value);
        if !filter.status_ids.is_empty() && !has(&filter.status_ids, &task.status_id) {
            return false;
        }
        if !filter.priorities.is_empty() && !filter.priorities.contains(&task.priority) {
            return false;
        }
        if !filter.project_ids.is_empty()
            && !task
                .project_id
                .as_deref()
                .is_some_and(|p| has(&filter.project_ids, p))
        {
            return false;
        }
        if !filter.epic_ids.is_empty()
            && !has(
                &filter.epic_ids,
                task.epic_id.as_deref().unwrap_or(FILTER_NONE),
            )
        {
            return false;
        }
        if !filter.tag_ids.is_empty() {
            let matched = if task.tag_ids.is_empty() {
                has(&filter.tag_ids, FILTER_NONE)
            } else {
                task.tag_ids.iter().any(|t| has(&filter.tag_ids, t))
            };
            if !matched {
                return false;
            }
        }
        filter.due.is_none_or(|due| self.matches_due(due, task))
    }

    /// Scope and filter together. Agents' own tasks (ADR 017) only show when asked for.
    fn matches(&self, spec: &ViewSpec, task: &Task, keep_closed_today: bool) -> bool {
        (spec.show_agent_tasks || task.owner != TaskOwner::Agent)
            && self.in_scope(&spec.scope, task, keep_closed_today)
            && self.matches_filter(&spec.filter, task)
    }

    /// Default order: picked for today, overdue, priority, due date, then manual rank.
    fn compare_default(&self, a: &Task, b: &Task) -> Ordering {
        let today = |t: &Task| t.today_on.as_deref() != Some(self.today);
        today(a)
            .cmp(&today(b))
            .then_with(|| (!self.is_overdue(a)).cmp(&!self.is_overdue(b)))
            .then_with(|| a.priority.to_db().cmp(&b.priority.to_db()))
            .then_with(|| compare_nullable(a.due_date.as_deref(), b.due_date.as_deref()))
            .then_with(|| compare_rank(a, b))
    }

    fn compare(&self, sort: SortBy, a: &Task, b: &Task) -> Ordering {
        match sort {
            SortBy::Default => self.compare_default(a, b),
            SortBy::Manual => compare_rank(a, b),
            SortBy::Due => compare_nullable(a.due_date.as_deref(), b.due_date.as_deref())
                .then_with(|| compare_rank(a, b)),
            SortBy::Priority => a
                .priority
                .to_db()
                .cmp(&b.priority.to_db())
                .then_with(|| self.compare_default(a, b)),
            SortBy::Created => b
                .created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id)),
            SortBy::Updated => b
                .updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id)),
        }
    }

    fn due_bucket(&self, task: &Task) -> &'static str {
        let Some(due) = task.due_date.as_deref() else {
            return "none";
        };
        match self.days_until(due) {
            d if d < 0 => {
                if self.is_open(task) {
                    "overdue"
                } else {
                    "today"
                }
            }
            0 => "today",
            1..=7 => "week",
            _ => "later",
        }
    }

    fn group_key(&self, by: GroupBy, task: &Task) -> String {
        match by {
            GroupBy::Status => task.status_id.clone(),
            GroupBy::Project => task
                .project_id
                .as_deref()
                .filter(|p| self.projects.contains_key(p))
                .unwrap_or("none")
                .to_owned(),
            GroupBy::Epic => task
                .epic_id
                .as_deref()
                .filter(|e| self.epics.contains_key(e))
                .unwrap_or("none")
                .to_owned(),
            GroupBy::Priority => priority_key(task.priority).to_owned(),
            GroupBy::Due => self.due_bucket(task).to_owned(),
        }
    }
}

/// Manual order only, for subtask checklists and board columns.
fn compare_rank(a: &Task, b: &Task) -> Ordering {
    a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id))
}

/// A missing value sorts last.
fn compare_nullable(a: Option<&str>, b: Option<&str>) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => a.cmp(b),
    }
}

const PRIORITIES: [Priority; 4] = [
    Priority::Urgent,
    Priority::High,
    Priority::Normal,
    Priority::Low,
];

fn priority_key(priority: Priority) -> &'static str {
    match priority {
        Priority::Urgent => "urgent",
        Priority::High => "high",
        Priority::Normal => "normal",
        Priority::Low => "low",
    }
}

fn priority_label(priority: Priority) -> &'static str {
    match priority {
        Priority::Urgent => "Urgent",
        Priority::High => "High",
        Priority::Normal => "Normal",
        Priority::Low => "Low",
    }
}

fn group(key: &str, label: &str, color: Option<&str>) -> ViewGroup {
    ViewGroup {
        key: key.to_owned(),
        label: label.to_owned(),
        color: color.map(str::to_owned),
    }
}

/// Every group of a grouping, in display order (empty ones are skipped by the caller).
fn groups(by: GroupBy, snapshot: &Snapshot) -> Vec<ViewGroup> {
    match by {
        GroupBy::Status => snapshot
            .statuses
            .iter()
            .map(|s| group(&s.id, &s.name, s.color.as_deref()))
            .collect(),
        GroupBy::Project => snapshot
            .projects
            .iter()
            .map(|p| group(&p.id, &p.name, p.color.as_deref()))
            .chain([group("none", "No project", None)])
            .collect(),
        GroupBy::Epic => snapshot
            .epics
            .iter()
            .map(|e| group(&e.id, &e.name, None))
            .chain([group("none", "No epic", None)])
            .collect(),
        GroupBy::Priority => PRIORITIES
            .iter()
            .map(|p| group(priority_key(*p), priority_label(*p), None))
            .collect(),
        GroupBy::Due => vec![
            group("overdue", "Overdue", Some("#ef4444")),
            group("today", "Today", Some("#f59e0b")),
            group("week", "Next 7 days", Some("#3b82f6")),
            group("later", "Later", None),
            group("none", "No due date", None),
        ],
    }
}

/// Live children of every task, in manual order.
fn children_by_parent(tasks: &[Task]) -> HashMap<&str, Vec<&Task>> {
    let mut map: HashMap<&str, Vec<&Task>> = HashMap::new();
    for task in tasks {
        if let Some(parent) = task.parent_id.as_deref() {
            map.entry(parent).or_default().push(task);
        }
    }
    for list in map.values_mut() {
        list.sort_by(|a, b| compare_rank(a, b));
    }
    map
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Rows for a list: grouped (status in workflow order by default), top-level tasks sorted
/// by the spec, each followed by its visible subtasks in manual order. A task whose parent
/// is not in the view is shown at the top level. Two levels are shown. Cancelled tasks
/// only show when asked for.
pub fn list_rows(snapshot: &Snapshot, spec: &ViewSpec, options: &ViewOptions) -> Vec<ViewRow> {
    let ctx = Ctx::new(snapshot, options);
    let children = children_by_parent(&snapshot.tasks);
    let visible: HashSet<&str> = snapshot
        .tasks
        .iter()
        .filter(|t| {
            ctx.matches(spec, t, false)
                && (spec.show_cancelled || ctx.category(t) != StatusCategory::Cancelled)
        })
        .map(|t| t.id.as_str())
        .collect();

    let mut roots: HashMap<String, Vec<&Task>> = HashMap::new();
    for task in &snapshot.tasks {
        if !visible.contains(task.id.as_str()) {
            continue;
        }
        if task
            .parent_id
            .as_deref()
            .is_some_and(|p| visible.contains(p))
        {
            continue;
        }
        roots
            .entry(ctx.group_key(spec.group_by, task))
            .or_default()
            .push(task);
    }

    let task_row = |task: &Task, depth: u8, visible_children: usize| {
        let kids = children
            .get(task.id.as_str())
            .map_or(&[][..], Vec::as_slice);
        ViewRow::Task {
            task: Box::new(task.clone()),
            depth,
            child_count: count(kids.len()),
            child_done: count(kids.iter().filter(|k| !ctx.is_open(k)).count()),
            visible_children: count(visible_children),
        }
    };

    let collapsed_groups: HashSet<&str> = options
        .collapsed_groups
        .iter()
        .map(String::as_str)
        .collect();
    let collapsed_tasks: HashSet<&str> =
        options.collapsed_tasks.iter().map(String::as_str).collect();

    let mut rows = Vec::new();
    for group in groups(spec.group_by, snapshot) {
        let Some(mut list) = roots.remove(&group.key) else {
            continue;
        };
        list.sort_by(|a, b| ctx.compare(spec.sort, a, b));
        let collapsed = collapsed_groups.contains(group.key.as_str());
        rows.push(ViewRow::Group {
            group,
            count: count(list.len()),
            collapsed,
        });
        if collapsed {
            continue;
        }
        for task in list {
            let kids: Vec<&Task> = children
                .get(task.id.as_str())
                .into_iter()
                .flatten()
                .copied()
                .filter(|c| visible.contains(c.id.as_str()))
                .collect();
            rows.push(task_row(task, 0, kids.len()));
            if collapsed_tasks.contains(task.id.as_str()) {
                continue;
            }
            for child in kids {
                rows.push(task_row(child, 1, 0));
            }
        }
    }
    rows
}

struct LaneSpec {
    key: String,
    label: String,
    color: Option<String>,
    changes: Vec<TaskChange>,
    order: String,
}

/// Sorts after every rank.
const LAST: &str = "\u{ffff}";

fn lane_of(task: &Task, swimlane: Swimlane, ctx: &Ctx<'_>) -> LaneSpec {
    match swimlane {
        Swimlane::None => LaneSpec {
            key: "all".into(),
            label: String::new(),
            color: None,
            changes: Vec::new(),
            order: String::new(),
        },
        Swimlane::Project => match task.project_id.as_deref().and_then(|p| ctx.projects.get(p)) {
            Some(project) => LaneSpec {
                key: format!("project:{}", project.id),
                label: project.name.clone(),
                color: project.color.clone(),
                changes: vec![TaskChange::ProjectId(Some(project.id.clone()))],
                order: project.rank.clone(),
            },
            None => LaneSpec {
                key: "project:none".into(),
                label: "No project".into(),
                color: None,
                changes: vec![TaskChange::ProjectId(None)],
                order: LAST.into(),
            },
        },
        Swimlane::Epic => match task.epic_id.as_deref().and_then(|e| ctx.epics.get(e)) {
            Some(epic) => LaneSpec {
                key: format!("epic:{}", epic.id),
                label: epic.name.clone(),
                color: None,
                changes: vec![TaskChange::EpicId(Some(epic.id.clone()))],
                order: epic.rank.clone(),
            },
            None => LaneSpec {
                key: "epic:none".into(),
                label: "No epic".into(),
                color: None,
                changes: vec![TaskChange::EpicId(None)],
                order: LAST.into(),
            },
        },
        Swimlane::Priority => LaneSpec {
            key: format!("priority:{}", priority_key(task.priority)),
            label: priority_label(task.priority).into(),
            color: None,
            changes: vec![TaskChange::Priority(task.priority)],
            order: task.priority.to_db().to_string(),
        },
    }
}

/// The board: columns are statuses in workflow order (a status filter limits them), cards
/// keep their manual order, and optional swimlanes split every column. Subtasks whose
/// parent is on the board are hidden unless the spec shows them. Unlike a list, a task
/// closed today stays in the Inbox and Today boards for the day.
pub fn board(snapshot: &Snapshot, spec: &ViewSpec, options: &ViewOptions) -> Board {
    let ctx = Ctx::new(snapshot, options);
    let children = children_by_parent(&snapshot.tasks);
    let visible: HashSet<&str> = snapshot
        .tasks
        .iter()
        .filter(|t| ctx.matches(spec, t, true))
        .map(|t| t.id.as_str())
        .collect();

    let wanted = &spec.filter.status_ids;
    let shown: Vec<&Status> = snapshot
        .statuses
        .iter()
        .filter(|s| {
            (s.category != StatusCategory::Cancelled
                || spec.show_cancelled
                || wanted.contains(&s.id))
                && (wanted.is_empty() || wanted.contains(&s.id))
        })
        .collect();
    let column_of: HashMap<&str, usize> = shown
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();

    let mut lanes: Vec<(LaneSpec, Vec<Vec<&Task>>)> = Vec::new();
    let mut lane_index: HashMap<String, usize> = HashMap::new();
    let mut counts = vec![0u32; shown.len()];
    for task in &snapshot.tasks {
        let Some(&column) = column_of.get(task.status_id.as_str()) else {
            continue;
        };
        if !visible.contains(task.id.as_str()) {
            continue;
        }
        let parent_shown = task
            .parent_id
            .as_deref()
            .is_some_and(|p| visible.contains(p));
        if parent_shown && !spec.show_subtasks {
            continue;
        }
        let lane = lane_of(task, spec.swimlane, &ctx);
        let index = *lane_index.entry(lane.key.clone()).or_insert_with(|| {
            lanes.push((lane, vec![Vec::new(); shown.len()]));
            lanes.len() - 1
        });
        lanes[index].1[column].push(task);
        counts[column] += 1;
    }

    lanes.sort_by(|(a, _), (b, _)| {
        a.order
            .cmp(&b.order)
            .then_with(|| a.label.cmp(&b.label))
            .then_with(|| a.key.cmp(&b.key))
    });
    if lanes.is_empty() {
        lanes.push((lane_of_all(), vec![Vec::new(); shown.len()]));
    }

    let card = |task: &Task| {
        let kids = children
            .get(task.id.as_str())
            .map_or(&[][..], Vec::as_slice);
        BoardCard {
            task: task.clone(),
            child_count: count(kids.len()),
            child_done: count(kids.iter().filter(|k| !ctx.is_open(k)).count()),
        }
    };

    Board {
        columns: shown
            .iter()
            .zip(&counts)
            .map(|(status, &count)| BoardColumn {
                status: (*status).clone(),
                count,
                over_limit: status
                    .wip_limit
                    .is_some_and(|limit| i64::from(count) > limit),
            })
            .collect(),
        lanes: lanes
            .into_iter()
            .map(|(lane, cells)| BoardLane {
                key: lane.key,
                label: lane.label,
                color: lane.color,
                changes: lane.changes,
                cells: cells
                    .into_iter()
                    .map(|mut cell| {
                        cell.sort_by(|a, b| compare_rank(a, b));
                        cell.into_iter().map(&card).collect()
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn lane_of_all() -> LaneSpec {
    LaneSpec {
        key: "all".into(),
        label: String::new(),
        color: None,
        changes: Vec::new(),
        order: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Vectors {
        options: ViewOptions,
        snapshot: Snapshot,
        list_cases: Vec<ListCase>,
        board_cases: Vec<BoardCase>,
    }

    #[derive(Deserialize)]
    struct ListCase {
        name: String,
        spec: ViewSpec,
        #[serde(default)]
        collapsed_groups: Vec<String>,
        #[serde(default)]
        collapsed_tasks: Vec<Id>,
        expected: Vec<String>,
    }

    #[derive(Deserialize)]
    struct BoardCase {
        name: String,
        spec: ViewSpec,
        expected: Vec<String>,
    }

    /// One line per row; the same encoding as `views.vectors.test.ts`.
    fn encode_rows(rows: &[ViewRow]) -> Vec<String> {
        rows.iter()
            .map(|row| match row {
                ViewRow::Group {
                    group,
                    count,
                    collapsed,
                } => format!(
                    "g|{}|{}|{}|{count}|{}",
                    group.key,
                    group.label,
                    group.color.as_deref().unwrap_or("-"),
                    u8::from(*collapsed)
                ),
                ViewRow::Task {
                    task,
                    depth,
                    child_count,
                    child_done,
                    visible_children,
                } => format!(
                    "t|{}|{depth}|{child_count}|{child_done}|{visible_children}",
                    task.id
                ),
            })
            .collect()
    }

    fn encode_board(board: &Board) -> Vec<String> {
        let mut out: Vec<String> = board
            .columns
            .iter()
            .map(|c| format!("c|{}|{}|{}", c.status.id, c.count, u8::from(c.over_limit)))
            .collect();
        for lane in &board.lanes {
            out.push(format!(
                "l|{}|{}|{}|{}",
                lane.key,
                lane.label,
                lane.color.as_deref().unwrap_or("-"),
                serde_json::to_string(&lane.changes).unwrap()
            ));
            for (column, cell) in board.columns.iter().zip(&lane.cells) {
                if cell.is_empty() {
                    continue;
                }
                let cards: Vec<String> = cell
                    .iter()
                    .map(|c| format!("{}:{}:{}", c.task.id, c.child_count, c.child_done))
                    .collect();
                out.push(format!("s|{}|{}", column.status.id, cards.join(",")));
            }
        }
        out
    }

    #[test]
    fn shared_vectors() {
        let vectors: Vectors =
            serde_json::from_str(include_str!("../test-vectors/views.json")).unwrap();
        assert!(vectors.list_cases.len() >= 20 && vectors.board_cases.len() >= 8);
        for case in vectors.list_cases {
            let options = ViewOptions {
                collapsed_groups: case.collapsed_groups,
                collapsed_tasks: case.collapsed_tasks,
                ..vectors.options.clone()
            };
            let rows = list_rows(&vectors.snapshot, &case.spec, &options);
            assert_eq!(encode_rows(&rows), case.expected, "list: {}", case.name);
        }
        for case in vectors.board_cases {
            let got = board(&vectors.snapshot, &case.spec, &vectors.options);
            assert_eq!(encode_board(&got), case.expected, "board: {}", case.name);
        }
    }

    #[test]
    fn a_task_closed_today_is_told_by_the_local_date() {
        let mut vectors: Vectors =
            serde_json::from_str(include_str!("../test-vectors/views.json")).unwrap();
        let done = vectors
            .snapshot
            .statuses
            .iter()
            .find(|s| s.category == StatusCategory::Done)
            .unwrap()
            .id
            .clone();
        let today_days = dates::to_days(&vectors.options.today).unwrap();
        // 23:30 UTC the day before: already today two hours east, not yet in UTC.
        let at = today_days * 86_400_000 - 30 * 60_000;
        let task = vectors
            .snapshot
            .tasks
            .iter_mut()
            .find(|t| t.project_id.is_none() && t.parent_id.is_none())
            .unwrap();
        task.status_id = done;
        task.completed_at = Some(at);
        let id = task.id.clone();
        let spec: ViewSpec =
            serde_json::from_str(r#"{"version":1,"scope":{"kind":"inbox"}}"#).unwrap();
        let on_board = |offset: i32| {
            let options = ViewOptions {
                utc_offset_min: offset,
                ..vectors.options.clone()
            };
            board(&vectors.snapshot, &spec, &options)
                .lanes
                .iter()
                .flat_map(|l| l.cells.iter().flatten())
                .any(|c| c.task.id == id)
        };
        assert!(on_board(120));
        assert!(!on_board(0));
    }
}
