//! The lineage as agents read it: the chains of prerequisites and dependents around a
//! task, or the dependency links among the open tasks of an epic or project (what the
//! Lineage view draws).

use std::collections::{HashMap, HashSet};

use taskmaster_core::{Snapshot, Status, Task};

use crate::{by_id, closed, task_line};

pub const DEFAULT_DEPTH: u32 = 3;
pub const MAX_DEPTH: u32 = 10;

struct Graph<'a> {
    tasks: HashMap<&'a str, &'a Task>,
    statuses: HashMap<&'a str, &'a Status>,
    /// Task → the tasks that list it as a prerequisite.
    dependents: HashMap<&'a str, Vec<&'a Task>>,
}

impl<'a> Graph<'a> {
    fn new(snapshot: &'a Snapshot) -> Self {
        let tasks: HashMap<&str, &Task> = snapshot
            .tasks
            .iter()
            .filter(|t| t.deleted_at.is_none())
            .map(|t| (t.id.as_str(), t))
            .collect();
        let mut dependents: HashMap<&str, Vec<&Task>> = HashMap::new();
        for &task in tasks.values() {
            for dep in &task.dependency_ids {
                if tasks.contains_key(dep.as_str()) {
                    dependents.entry(dep.as_str()).or_default().push(task);
                }
            }
        }
        for list in dependents.values_mut() {
            list.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
        }
        Self {
            tasks,
            statuses: by_id(&snapshot.statuses),
            dependents,
        }
    }

    fn prerequisites(&self, task: &Task) -> Vec<&'a Task> {
        let mut list: Vec<&Task> = task
            .dependency_ids
            .iter()
            .filter_map(|id| self.tasks.get(id.as_str()).copied())
            .collect();
        list.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
        list
    }

    fn dependents(&self, task: &Task) -> Vec<&'a Task> {
        self.dependents
            .get(task.id.as_str())
            .cloned()
            .unwrap_or_default()
    }

    fn open_prerequisites(&self, task: &Task) -> Vec<&'a Task> {
        self.prerequisites(task)
            .into_iter()
            .filter(|t| !closed(&self.statuses, t))
            .collect()
    }

    /// An indented tree following `next`, `depth` levels down. A task met twice is
    /// listed again without its branch.
    fn tree(
        &self,
        root: &Task,
        depth: u32,
        next: impl Fn(&Self, &Task) -> Vec<&'a Task> + Copy,
    ) -> Vec<String> {
        let mut lines = Vec::new();
        let mut seen = HashSet::from([root.id.as_str()]);
        let mut stack: Vec<(&Task, u32)> =
            next(self, root).into_iter().rev().map(|t| (t, 1)).collect();
        while let Some((task, level)) = stack.pop() {
            let indent = "  ".repeat(level as usize - 1);
            let line = task_line(&self.statuses, task);
            if !seen.insert(task.id.as_str()) {
                lines.push(format!("{indent}{line} (listed above)"));
                continue;
            }
            let children = next(self, task);
            if level == depth && !children.is_empty() {
                lines.push(format!("{indent}{line} (+{} further)", children.len()));
                continue;
            }
            lines.push(format!("{indent}{line}"));
            stack.extend(children.into_iter().rev().map(|t| (t, level + 1)));
        }
        lines
    }

    fn readiness(&self, task: &Task) -> String {
        let all = self.prerequisites(task);
        let open = self.open_prerequisites(task);
        if all.is_empty() {
            "No prerequisites.".into()
        } else if open.is_empty() {
            "Ready: every prerequisite is finished.".into()
        } else {
            format!(
                "Waiting: {} of {} prerequisites open.",
                open.len(),
                all.len()
            )
        }
    }
}

/// The lineage of one task: prerequisites upstream and dependents downstream.
pub fn of_task(snapshot: &Snapshot, task_id: &str, depth: u32) -> Result<String, String> {
    let graph = Graph::new(snapshot);
    let task = graph
        .tasks
        .get(task_id)
        .copied()
        .ok_or_else(|| format!("task {task_id} not found"))?;
    let depth = depth.clamp(1, MAX_DEPTH);
    let mut out = format!(
        "# Lineage: {}\n{}\n",
        task_line(&graph.statuses, task).trim_start_matches("- "),
        graph.readiness(task)
    );
    out.push_str("\n## Prerequisites (finished first; nested: theirs)\n");
    out.push_str(&section(graph.tree(task, depth, Graph::prerequisites)));
    out.push_str("\n\n## Dependents (waiting on it; nested: theirs)\n");
    out.push_str(&section(graph.tree(task, depth, Graph::dependents)));
    out.push('\n');
    Ok(out)
}

fn section(lines: Vec<String>) -> String {
    if lines.is_empty() {
        "None.".to_owned()
    } else {
        lines.join("\n")
    }
}

/// The open tasks matching `keep` that are linked to another task, ready ones first.
pub fn of_scope(snapshot: &Snapshot, keep: impl Fn(&Task) -> bool, label: &str) -> String {
    let graph = Graph::new(snapshot);
    let mut linked: Vec<&Task> = graph
        .tasks
        .values()
        .copied()
        .filter(|&t| keep(t) && !closed(&graph.statuses, t))
        .filter(|t| !graph.prerequisites(t).is_empty() || !graph.dependents(t).is_empty())
        .collect();
    linked.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id)));
    if linked.is_empty() {
        return format!("No open task in {label} is linked to another.");
    }
    let (ready, waiting): (Vec<&Task>, Vec<&Task>) = linked
        .into_iter()
        .partition(|t| graph.open_prerequisites(t).is_empty());
    let mut out = format!("# Lineage of {label}\n");
    let titles = |list: Vec<&Task>| {
        list.iter()
            .map(|t| format!("{} (`{}`)", t.title, t.id))
            .collect::<Vec<_>>()
            .join(", ")
    };
    if !ready.is_empty() {
        out.push_str("\n## Ready (no open prerequisite)\n");
        for task in ready {
            out.push_str(&task_line(&graph.statuses, task));
            let deps = graph.dependents(task);
            if !deps.is_empty() {
                out.push_str(&format!("\n  unblocks: {}", titles(deps)));
            }
            out.push('\n');
        }
    }
    if !waiting.is_empty() {
        out.push_str("\n## Waiting\n");
        for task in waiting {
            out.push_str(&task_line(&graph.statuses, task));
            out.push_str(&format!(
                "\n  waits on: {}\n",
                titles(graph.open_prerequisites(task))
            ));
        }
    }
    out
}
