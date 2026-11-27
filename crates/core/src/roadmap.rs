//! The Roadmap's model (ADR 031) in the core, so the sync server can draw a roadmap image
//! (ADR 035) from its own replica: the epics or one epic's tasks a roadmap spec picks, their
//! bars, the rows and the dependency links, as the [`RoadmapImage`] the desktop page builds.
//!
//! A port of `apps/desktop/src/features/roadmap/timeline.ts` and `model.ts` (and the task
//! filter of `features/lineage/graph.ts`). Both sides must agree: they share the cases in
//! `test-vectors/roadmap.json`. Dates stay `YYYY-MM-DD` strings and compare as text, as
//! they do there; ranks and ids compare byte by byte, as everywhere else in the app.
//!
//! Where a bar starts belongs to the roadmap. A saved view keeps the starts it showed when
//! saved; the plain Roadmap page keeps them in the desktop's local storage, out of reach of
//! anything else, so a roadmap built here from a spec without starts uses the default
//! rules (a task's estimate, an epic's earliest task, else two working weeks).

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::model::{
    Epic, EpicState, FILTER_NONE, GroupBy, Id, IsoDate, Layout, LineageCompletion, Project,
    RoadmapGroup, RoadmapSpec, RoadmapZoom, Snapshot, SortBy, Status, StatusCategory, Swimlane,
    Task, TaskOwner, VIEW_SPEC_VERSION, ViewFilter, ViewScope, ViewSpec,
};
use crate::parse::dates::{to_days, to_iso};
use crate::roadmap_image::{ImageDeadline, ImageLink, ImageRow, ImageTheme, RoadmapImage};

/// Working days a new epic bar takes, and how early an epic without tasks starts.
const EPIC_DAYS: i64 = 10;
/// A group header's label for epics without a home project.
const NO_PROJECT: &str = "No project";

/// What a roadmap is built from: the live entities (agents' tasks among them; they are
/// left out here).
#[derive(Debug, Clone, Copy)]
pub struct RoadmapData<'a> {
    pub tasks: &'a [Task],
    pub epics: &'a [Epic],
    pub projects: &'a [Project],
    pub statuses: &'a [Status],
}

impl<'a> RoadmapData<'a> {
    pub fn of(snapshot: &'a Snapshot) -> Self {
        Self {
            tasks: &snapshot.tasks,
            epics: &snapshot.epics,
            projects: &snapshot.projects,
            statuses: &snapshot.statuses,
        }
    }
}

/// What the image says beside the spec: the saved view's name (its heading, and how the
/// subtitle reads), the day it is drawn for and its theme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoadmapOptions {
    #[serde(default)]
    pub view_name: Option<String>,
    pub today: IsoDate,
    #[serde(default)]
    pub theme: ImageTheme,
}

/// The spec the plain Roadmap page starts from (its `DEFAULT_FILTER`): the roadmap of
/// epics (active ones, by project, by month), or with `epic` that epic's open tasks by week,
/// subtasks shown. No starts, nothing folded.
pub fn default_roadmap_spec(epic: Option<Id>) -> ViewSpec {
    let zoom = if epic.is_some() {
        RoadmapZoom::Week
    } else {
        RoadmapZoom::Month
    };
    let group = if epic.is_some() {
        RoadmapGroup::None
    } else {
        RoadmapGroup::Project
    };
    ViewSpec {
        version: VIEW_SPEC_VERSION,
        scope: ViewScope::All,
        filter: ViewFilter::default(),
        group_by: GroupBy::default(),
        sort: SortBy::default(),
        layout: Layout::default(),
        swimlane: Swimlane::default(),
        show_subtasks: true,
        show_cancelled: false,
        show_agent_tasks: false,
        show_closed_lanes: false,
        lineage: None,
        roadmap: Some(Box::new(RoadmapSpec {
            epic,
            completion: LineageCompletion::Open,
            group,
            zoom,
            starts: BTreeMap::new(),
            collapsed: Vec::new(),
            hide_unscheduled: false,
        })),
    }
}

// ---------------------------------------------------------------------------------------
// Days and bars

fn day_of(iso: &str) -> Result<i64> {
    to_days(iso).ok_or_else(|| Error::invalid(format!("'{iso}' is not a date")))
}

fn is_weekend(day: i64) -> bool {
    // 1970-01-01 was a Thursday; 0 is Sunday here, as in timeline.ts.
    matches!((day + 4).rem_euclid(7), 0 | 6)
}

/// Working days an estimate takes, at eight hours a day; at least one.
fn estimate_days(minutes: Option<i64>) -> i64 {
    let minutes = minutes.unwrap_or(0);
    (minutes.div_euclid(480) + i64::from(minutes.rem_euclid(480) > 0)).max(1)
}

/// The day `count` working days away (weekends skipped); `count` 0 is the day itself.
/// Whole weeks at once (each holds five working days), so a huge estimate costs nothing.
fn add_working_days(iso: &str, count: i64) -> Result<String> {
    let mut day = day_of(iso)?;
    if count == 0 {
        return Ok(to_iso(day));
    }
    let step = count.signum();
    let n = count.unsigned_abs() as i64;
    let weeks = (n - 1) / 5;
    day = day.saturating_add(step.saturating_mul(weeks.saturating_mul(7)));
    let mut left = n - weeks * 5;
    while left > 0 {
        day += step;
        if !is_weekend(day) {
            left -= 1;
        }
    }
    Ok(to_iso(day))
}

fn earlier<'s>(a: &'s str, b: &'s str) -> &'s str {
    if b < a { b } else { a }
}

fn later<'s>(a: &'s str, b: &'s str) -> &'s str {
    if b > a { b } else { a }
}

/// A bar: from its first day to its last, both included.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Bar {
    start: String,
    end: String,
}

impl Bar {
    fn new(start: &str, end: &str) -> Self {
        Self {
            start: earlier(start, end).to_owned(),
            end: end.to_owned(),
        }
    }
}

/// From the first start to the last end.
fn hull<'b>(bars: impl IntoIterator<Item = &'b Bar>) -> Option<Bar> {
    let mut out: Option<Bar> = None;
    for bar in bars {
        out = Some(match out {
            None => bar.clone(),
            Some(o) => Bar {
                start: earlier(&o.start, &bar.start).to_owned(),
                end: later(&o.end, &bar.end).to_owned(),
            },
        });
    }
    out
}

/// A task's bar: it ends on the due date and starts on the roadmap's start for it, or as
/// many working days earlier as its estimate takes. No due date, no bar.
fn bar_of(task: &Task, starts: &BTreeMap<Id, IsoDate>) -> Result<Option<Bar>> {
    let Some(end) = &task.due_date else {
        return Ok(None);
    };
    let start = match starts.get(&task.id) {
        Some(start) => start.clone(),
        None => add_working_days(end, -(estimate_days(task.estimate_min) - 1))?,
    };
    Ok(Some(Bar::new(&start, end)))
}

/// An epic's bar: it ends on its target date and starts on the roadmap's start for it, else
/// where its earliest task starts, else two working weeks before. No target date, no bar.
fn epic_bar(epic: &Epic, starts: &BTreeMap<Id, IsoDate>, tasks: &[Bar]) -> Result<Option<Bar>> {
    let Some(end) = &epic.target_date else {
        return Ok(None);
    };
    let start = match (starts.get(&epic.id), hull(tasks)) {
        (Some(start), _) => start.clone(),
        (None, Some(first)) => first.start,
        (None, None) => add_working_days(end, -(EPIC_DAYS - 1))?,
    };
    Ok(Some(Bar::new(&start, end)))
}

// ---------------------------------------------------------------------------------------
// Items, rows, links

/// An epic on the roadmap, or a task on an epic's timeline.
#[derive(Debug, Clone)]
struct Item {
    id: String,
    title: String,
    rank: String,
    bar: Option<Bar>,
    done: bool,
    progress: Option<f64>,
    color: Option<String>,
    /// A project id, [`FILTER_NONE`], or "" without groups.
    group: String,
    parent: Option<String>,
    after: Vec<String>,
}

fn task_item(task: &Task, bar: Option<Bar>, done: bool) -> Item {
    Item {
        id: task.id.clone(),
        title: task.title.clone(),
        rank: task.rank.clone(),
        bar,
        done,
        progress: None,
        color: None,
        group: String::new(),
        parent: task.parent_id.clone(),
        after: task.dependency_ids.clone(),
    }
}

/// The epics as items: bars, progress (done tasks out of those not cancelled), and the
/// epics they wait on through their tasks' prerequisites in other shown epics.
fn epic_items(
    epics: &[&Epic],
    tasks: &[&Task],
    starts: &BTreeMap<Id, IsoDate>,
    done: &HashSet<&str>,
    cancelled: &HashSet<&str>,
    group_of: impl Fn(&Epic) -> String,
) -> Result<Vec<Item>> {
    let shown: HashSet<&str> = epics.iter().map(|e| e.id.as_str()).collect();
    let by_id: HashMap<&str, &Task> = tasks.iter().map(|t| (t.id.as_str(), *t)).collect();
    let mut members: HashMap<&str, Vec<&Task>> = HashMap::new();
    let mut after: HashMap<&str, HashSet<&str>> = HashMap::new();
    for task in tasks {
        let Some(epic) = task.epic_id.as_deref().filter(|e| shown.contains(e)) else {
            continue;
        };
        members.entry(epic).or_default().push(task);
        for id in &task.dependency_ids {
            if let Some(other) = by_id.get(id.as_str()).and_then(|t| t.epic_id.as_deref())
                && other != epic
                && shown.contains(other)
            {
                after.entry(epic).or_default().insert(other);
            }
        }
    }
    epics
        .iter()
        .map(|epic| {
            let list: Vec<&Task> = members
                .get(epic.id.as_str())
                .map(|m| {
                    m.iter()
                        .copied()
                        .filter(|t| !cancelled.contains(t.id.as_str()))
                        .collect()
                })
                .unwrap_or_default();
            let finished = list.iter().filter(|t| done.contains(t.id.as_str())).count();
            let mut bars = Vec::new();
            for task in &list {
                if let Some(bar) = bar_of(task, starts)? {
                    bars.push(bar);
                }
            }
            let mut waits: Vec<String> = after
                .get(epic.id.as_str())
                .map(|s| s.iter().map(|id| (*id).to_owned()).collect())
                .unwrap_or_default();
            waits.sort();
            Ok(Item {
                id: epic.id.clone(),
                title: epic.name.clone(),
                rank: epic.rank.clone(),
                bar: epic_bar(epic, starts, &bars)?,
                done: epic.state != EpicState::Active,
                progress: Some(if list.is_empty() {
                    0.0
                } else {
                    finished as f64 / list.len() as f64
                }),
                color: epic.color.clone(),
                group: group_of(epic),
                parent: None,
                after: waits,
            })
        })
        .collect()
}

/// One line: a group's header, or an item (by index) and how deep it is nested.
enum Row {
    Group {
        label: String,
        color: Option<String>,
        count: usize,
        span: Option<Bar>,
    },
    Item {
        index: usize,
        depth: u32,
    },
}

/// Scheduled items first, by start, then by rank and id.
fn by_start(a: &Item, b: &Item) -> Ordering {
    match (&a.bar, &b.bar) {
        (Some(x), Some(y)) if x.start != y.start => return x.start.cmp(&y.start),
        (Some(_), None) => return Ordering::Less,
        (None, Some(_)) => return Ordering::Greater,
        _ => {}
    }
    a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id))
}

/// Items (indices into `items`) in order, each followed by its subtasks.
fn nested(items: &[Item], list: &[usize], rows: &mut Vec<Row>) {
    let ids: HashSet<&str> = list.iter().map(|&i| items[i].id.as_str()).collect();
    let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut top = Vec::new();
    for &i in list {
        match items[i].parent.as_deref() {
            Some(parent) if ids.contains(parent) => children.entry(parent).or_default().push(i),
            _ => top.push(i),
        }
    }
    let order = |v: &mut Vec<usize>| v.sort_by(|&a, &b| by_start(&items[a], &items[b]));
    for v in children.values_mut() {
        order(v);
    }
    order(&mut top);
    let mut seen = HashSet::new();
    // Depth first, children in order: a stack of (item, depth), pushed in reverse.
    let mut stack: Vec<(usize, u32)> = top.iter().rev().map(|&i| (i, 0)).collect();
    while let Some((i, depth)) = stack.pop() {
        if !seen.insert(i) {
            continue;
        }
        rows.push(Row::Item { index: i, depth });
        if let Some(kids) = children.get(items[i].id.as_str()) {
            stack.extend(kids.iter().rev().map(|&k| (k, depth + 1)));
        }
    }
}

/// The rows: items under their group (by the project's rank, "none" last) or in one list.
/// A folded group keeps its header.
fn rows_of(
    items: &[Item],
    owners: Option<&HashMap<&str, &Project>>,
    collapsed: &HashSet<&str>,
) -> Vec<Row> {
    let mut rows = Vec::new();
    let all: Vec<usize> = (0..items.len()).collect();
    let Some(owners) = owners else {
        nested(items, &all, &mut rows);
        return rows;
    };
    let mut members: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, item) in items.iter().enumerate() {
        members.entry(item.group.as_str()).or_default().push(i);
    }
    let mut keys: Vec<&str> = members.keys().copied().collect();
    let rank = |key: &str| owners.get(key).map_or("", |p| p.rank.as_str());
    keys.sort_by(|a, b| match (*a == FILTER_NONE, *b == FILTER_NONE) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => rank(a).cmp(rank(b)).then_with(|| a.cmp(b)),
    });
    for key in keys {
        let list = &members[key];
        let owner = owners.get(key);
        rows.push(Row::Group {
            label: owner.map_or(NO_PROJECT, |p| p.name.as_str()).to_owned(),
            color: owner.and_then(|p| p.color.clone()),
            count: list.len(),
            span: hull(list.iter().filter_map(|&i| items[i].bar.as_ref())),
        });
        if !collapsed.contains(key) {
            nested(items, list, &mut rows);
        }
    }
    rows
}

/// The image's rows; a group without a bar under it and an item without a bar stay out.
fn image_rows(items: &[Item], rows: &[Row]) -> Vec<ImageRow> {
    rows.iter()
        .filter_map(|row| match row {
            Row::Group {
                label,
                color,
                count,
                span,
            } => span.as_ref().map(|span| ImageRow::Group {
                label: label.clone(),
                color: color.clone(),
                count: u32::try_from(*count).unwrap_or(u32::MAX),
                start: span.start.clone(),
                end: span.end.clone(),
            }),
            Row::Item { index, depth } => {
                let item = &items[*index];
                item.bar.as_ref().map(|bar| ImageRow::Item {
                    id: item.id.clone(),
                    title: item.title.clone(),
                    depth: *depth,
                    start: bar.start.clone(),
                    end: bar.end.clone(),
                    done: item.done,
                    progress: item.progress,
                    color: item.color.clone(),
                })
            }
        })
        .collect()
}

/// Arrows between items that are both in the image: what waits on what.
fn image_links(items: &[Item], rows: &[ImageRow]) -> Vec<ImageLink> {
    let shown: HashSet<&str> = rows
        .iter()
        .filter_map(|row| match row {
            ImageRow::Item { id, .. } => Some(id.as_str()),
            ImageRow::Group { .. } => None,
        })
        .collect();
    let with_bar: HashSet<&str> = items
        .iter()
        .filter(|i| i.bar.is_some())
        .map(|i| i.id.as_str())
        .collect();
    let mut links = Vec::new();
    for item in items.iter().filter(|i| i.bar.is_some()) {
        for from in &item.after {
            if with_bar.contains(from.as_str())
                && shown.contains(from.as_str())
                && shown.contains(item.id.as_str())
            {
                links.push(ImageLink {
                    from: from.clone(),
                    to: item.id.clone(),
                });
            }
        }
    }
    links
}

/// "Nov 21, 2026".
fn as_of(today: &str) -> Result<String> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    day_of(today)?;
    let month: usize = today[5..7].parse().unwrap_or(1);
    let day: u32 = today[8..10].parse().unwrap_or(1);
    Ok(format!(
        "{} {day}, {}",
        MONTHS[month.clamp(1, 12) - 1],
        &today[..4]
    ))
}

// ---------------------------------------------------------------------------------------
// The roadmap

/// The roadmap a spec shows, as an image: the epics of its projects or the tasks of its
/// epic, only those with a bar. A spec without `roadmap` is the plain page's defaults
/// (`default_roadmap_spec(None)`'s roadmap). An epic that is not live is `not_found`.
pub fn roadmap_image(
    data: RoadmapData<'_>,
    spec: &ViewSpec,
    options: &RoadmapOptions,
) -> Result<RoadmapImage> {
    let fallback = default_roadmap_spec(None);
    let roadmap = spec
        .roadmap
        .as_deref()
        .or(fallback.roadmap.as_deref())
        .ok_or_else(|| Error::invalid("not a roadmap"))?;
    day_of(&options.today)?;

    // Agents' own steps stay off the roadmap, as they stay out of lists by default.
    let live: Vec<&Task> = data
        .tasks
        .iter()
        .filter(|t| t.deleted_at.is_none())
        .collect();
    let mut all: Vec<&Task> = live
        .iter()
        .copied()
        .filter(|t| t.owner != TaskOwner::Agent)
        .collect();
    all.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
    let category: HashMap<&str, StatusCategory> = data
        .statuses
        .iter()
        .map(|s| (s.id.as_str(), s.category))
        .collect();
    let in_category = |task: &Task, wanted: &[StatusCategory]| {
        category
            .get(task.status_id.as_str())
            .is_some_and(|c| wanted.contains(c))
    };
    // Done and cancelled tasks no longer block anything.
    let closed: HashSet<&str> = live
        .iter()
        .filter(|t| in_category(t, &[StatusCategory::Done, StatusCategory::Cancelled]))
        .map(|t| t.id.as_str())
        .collect();
    let cancelled: HashSet<&str> = all
        .iter()
        .filter(|t| in_category(t, &[StatusCategory::Cancelled]))
        .map(|t| t.id.as_str())
        .collect();
    let projects: HashMap<&str, &Project> = data
        .projects
        .iter()
        .filter(|p| p.deleted_at.is_none())
        .map(|p| (p.id.as_str(), p))
        .collect();
    let epics: Vec<&Epic> = data
        .epics
        .iter()
        .filter(|e| e.deleted_at.is_none())
        .collect();
    let starts = &roadmap.starts;
    let picked = &spec.filter.project_ids;

    let (items, epic, grouped) = match &roadmap.epic {
        None => {
            let in_picked = |id: &str| {
                all.iter().any(|t| {
                    t.epic_id.as_deref() == Some(id)
                        && picked
                            .iter()
                            .any(|p| *p == t.project_id.as_deref().unwrap_or(""))
                })
            };
            let shown: Vec<&Epic> = epics
                .iter()
                .copied()
                .filter(|e| {
                    (roadmap.completion == LineageCompletion::All || e.state == EpicState::Active)
                        && (picked.is_empty()
                            || picked
                                .iter()
                                .any(|p| *p == e.project_id.as_deref().unwrap_or(FILTER_NONE))
                            || (e.project_id.is_none() && in_picked(&e.id)))
                })
                .collect();
            let grouped = roadmap.group == RoadmapGroup::Project;
            let items = epic_items(&shown, &all, starts, &closed, &cancelled, |e| {
                if grouped {
                    e.project_id
                        .clone()
                        .unwrap_or_else(|| FILTER_NONE.to_owned())
                } else {
                    String::new()
                }
            })?;
            (items, None, grouped)
        }
        Some(id) => {
            let epic = epics
                .iter()
                .copied()
                .find(|e| e.id == *id)
                .ok_or_else(|| Error::not_found("epic", id.clone()))?;
            let by_id: HashMap<&str, &Task> = live.iter().map(|t| (t.id.as_str(), *t)).collect();
            let tags = &spec.filter.tag_ids;
            let blocked = |task: &Task| {
                task.dependency_ids
                    .iter()
                    .any(|d| by_id.contains_key(d.as_str()) && !closed.contains(d.as_str()))
            };
            let mut items = Vec::new();
            for task in &all {
                let matches = task.epic_id.as_deref() == Some(id.as_str())
                    && (tags.is_empty()
                        || if task.tag_ids.is_empty() {
                            tags.iter().any(|t| t == FILTER_NONE)
                        } else {
                            task.tag_ids.iter().any(|t| tags.contains(t))
                        })
                    && (spec.show_subtasks || task.parent_id.is_none())
                    && (roadmap.completion == LineageCompletion::All
                        || !closed.contains(task.id.as_str()))
                    && (roadmap.completion != LineageCompletion::Ready || !blocked(task));
                if matches {
                    let bar = bar_of(task, starts)?;
                    items.push(task_item(task, bar, closed.contains(task.id.as_str())));
                }
            }
            (items, Some(epic), false)
        }
    };

    let scheduled: Vec<Item> = items.into_iter().filter(|i| i.bar.is_some()).collect();
    let collapsed: HashSet<&str> = roadmap.collapsed.iter().map(String::as_str).collect();
    let rows = rows_of(&scheduled, grouped.then_some(&projects), &collapsed);
    let rows = image_rows(&scheduled, &rows);
    let links = image_links(&scheduled, &rows);

    let count = scheduled.len();
    let noun = match (epic.is_some(), count == 1) {
        (false, true) => "epic",
        (false, false) => "epics",
        (true, true) => "task",
        (true, false) => "tasks",
    };
    let what = match epic {
        None if picked.is_empty() => "Epics across projects".to_owned(),
        None => {
            let names: Vec<&str> = picked
                .iter()
                .map(|id| {
                    if id == FILTER_NONE {
                        NO_PROJECT
                    } else {
                        projects.get(id.as_str()).map_or("", |p| p.name.as_str())
                    }
                })
                .filter(|name| !name.is_empty())
                .collect();
            format!("Epics of {}", names.join(", "))
        }
        Some(epic) if options.view_name.is_some() => format!("The tasks of {}", epic.name),
        Some(_) => "Epic timeline".to_owned(),
    };
    let title = options
        .view_name
        .clone()
        .or_else(|| epic.map(|e| e.name.clone()))
        .unwrap_or_else(|| "Roadmap".to_owned());
    Ok(RoadmapImage {
        title,
        subtitle: format!("{what} · {count} {noun} · {}", as_of(&options.today)?),
        name_header: if epic.is_some() { "Task" } else { "Epic" }.to_owned(),
        zoom: roadmap.zoom,
        today: options.today.clone(),
        deadline: epic.and_then(|e| {
            e.target_date.as_ref().map(|date| ImageDeadline {
                date: date.clone(),
                label: e.name.clone(),
            })
        }),
        rows,
        links,
        theme: options.theme,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn working_days_skip_weekends_in_whole_weeks_too() {
        // 2026-11-20 is a Friday.
        let step = |iso: &str, n: i64| add_working_days(iso, n).unwrap();
        assert_eq!(step("2026-11-20", 0), "2026-11-20");
        assert_eq!(step("2026-11-20", 1), "2026-11-23");
        assert_eq!(step("2026-11-20", 6), "2026-11-30");
        assert_eq!(step("2026-11-21", 6), "2026-11-30"); // from a Saturday
        assert_eq!(step("2026-11-20", -1), "2026-11-19");
        assert_eq!(step("2026-11-23", -1), "2026-11-20");
        assert_eq!(step("2026-11-22", -5), "2026-11-16"); // from a Sunday
        // Against a day-by-day walk, from every weekday, both ways.
        for start in 0..7 {
            let from = to_iso(to_days("2026-11-16").unwrap() + start);
            for n in -23..=23_i64 {
                let mut day = to_days(&from).unwrap();
                let mut left = n.abs();
                while left > 0 {
                    day += n.signum();
                    if !is_weekend(day) {
                        left -= 1;
                    }
                }
                assert_eq!(step(&from, n), to_iso(day), "{from} {n}");
            }
        }
    }

    #[test]
    fn estimates_are_whole_working_days() {
        assert_eq!(estimate_days(None), 1);
        assert_eq!(estimate_days(Some(-30)), 1);
        assert_eq!(estimate_days(Some(480)), 1);
        assert_eq!(estimate_days(Some(481)), 2);
        assert_eq!(estimate_days(Some(i64::MAX)), i64::MAX / 480 + 1);
    }

    #[test]
    fn as_of_is_english() {
        assert_eq!(as_of("2026-11-21").unwrap(), "Nov 21, 2026");
        assert_eq!(as_of("2027-01-05").unwrap(), "Jan 5, 2027");
        assert!(as_of("nope").is_err());
    }

    /// The cases shared with `features/roadmap/model.test.ts`.
    #[derive(Deserialize)]
    struct Vectors {
        data: VectorData,
        defaults: VectorDefaults,
        cases: Vec<Case>,
    }

    #[derive(Deserialize)]
    struct VectorData {
        tasks: Vec<Task>,
        epics: Vec<Epic>,
        projects: Vec<Project>,
        statuses: Vec<Status>,
    }

    #[derive(Deserialize)]
    struct VectorDefaults {
        epics: ViewSpec,
        tasks: ViewSpec,
    }

    #[derive(Deserialize)]
    struct Case {
        name: String,
        spec: ViewSpec,
        options: RoadmapOptions,
        expected: RoadmapImage,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../test-vectors/roadmap.json")).unwrap()
    }

    #[test]
    fn shared_vectors_agree() {
        let v = vectors();
        let data = RoadmapData {
            tasks: &v.data.tasks,
            epics: &v.data.epics,
            projects: &v.data.projects,
            statuses: &v.data.statuses,
        };
        assert!(v.cases.len() >= 8);
        for case in &v.cases {
            let got = roadmap_image(data, &case.spec, &case.options).unwrap();
            assert_eq!(got, case.expected, "case '{}'", case.name);
            // And it draws, when there is a bar to draw.
            let drawn = crate::roadmap_image::render(&got);
            assert_eq!(drawn.is_ok(), !got.rows.is_empty(), "case '{}'", case.name);
        }
    }

    #[test]
    fn defaults_are_the_pages() {
        let v = vectors();
        let roadmap = |spec: &ViewSpec| spec.roadmap.as_deref().cloned().unwrap();
        let epics = default_roadmap_spec(None);
        assert_eq!(roadmap(&epics), roadmap(&v.defaults.epics));
        assert_eq!(epics.show_subtasks, v.defaults.epics.show_subtasks);
        assert_eq!(epics.filter, v.defaults.epics.filter);
        let epic = roadmap(&v.defaults.tasks).epic;
        assert!(epic.is_some());
        let tasks = default_roadmap_spec(epic);
        assert_eq!(roadmap(&tasks), roadmap(&v.defaults.tasks));
        assert_eq!(tasks.show_subtasks, v.defaults.tasks.show_subtasks);
    }

    #[test]
    fn a_missing_epic_is_not_found() {
        let v = vectors();
        let data = RoadmapData {
            tasks: &v.data.tasks,
            epics: &v.data.epics,
            projects: &v.data.projects,
            statuses: &v.data.statuses,
        };
        let spec = default_roadmap_spec(Some("01e00000-0000-7000-8000-00000000dead".into()));
        let options = RoadmapOptions {
            view_name: None,
            today: "2026-11-21".into(),
            theme: ImageTheme::Clean,
        };
        let err = roadmap_image(data, &spec, &options).unwrap_err();
        assert_eq!(err.kind(), "not_found");
    }
}
