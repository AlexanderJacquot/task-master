// Sample data for the demo page (README screenshots). Development only.
import type { Epic, Project, Snapshot, Tag, Task } from "../lib/types";
import { STATUS, snapshot, task } from "../test/fixtures";

const day = 86_400_000;
const now = Date.now();
function iso(offsetDays: number): string {
  const d = new Date(now + offsetDays * day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const stamp = { created_at: now - 20 * day, updated_at: now - day, deleted_at: null };

function project(id: string, name: string, color: string, icon: string, rank: string): Project {
  return { id, parent_id: null, name, color, icon, rank, archived_at: null, ...stamp };
}
function epic(
  id: string,
  project_id: string,
  name: string,
  color: string,
  icon: string,
  rank: string,
): Epic {
  return {
    id,
    project_id,
    name,
    color,
    icon,
    description: null,
    target_date: null,
    state: "active",
    rank,
    ...stamp,
  };
}
function tag(id: string, name: string, color: string): Tag {
  return { id, name, color, ...stamp };
}

export const projects = [
  project("p-site", "Website relaunch", "#8b5cf6", "img:castle", "a0"),
  project("p-book", "Field guide", "#14b8a6", "img:quill", "a1"),
  project("p-home", "Home", "#f59e0b", "img:house", "a2"),
];
export const epics = [
  epic("e-design", "p-site", "Design system", "#8b5cf6", "crown", "a0"),
  epic("e-shop", "p-site", "Checkout", "#ef4444", "shield", "a1"),
  epic("e-launch", "p-site", "Launch", "#0ea5e9", "star", "a2"),
];
export const tags = [
  tag("g-design", "design", "#8b5cf6"),
  tag("g-front", "frontend", "#0ea5e9"),
  tag("g-copy", "writing", "#14b8a6"),
  tag("g-errand", "errand", "#f59e0b"),
];

function t(overrides: Partial<Task>): Task {
  return task({ ...stamp, ...overrides });
}

const tokens = t({
  title: "Define color and type tokens",
  project_id: "p-site",
  epic_id: "e-design",
  status_id: STATUS.done,
  completed_at: now - 5 * day,
  tag_ids: ["g-design"],
});
const components = t({
  title: "Build button, input and card components",
  project_id: "p-site",
  epic_id: "e-design",
  status_id: STATUS.inProgress,
  dependency_ids: [tokens.id],
  tag_ids: ["g-front"],
  priority: "high",
  today_on: iso(0),
  estimate_min: 120,
});
const icons = t({
  title: "Draw the icon set",
  project_id: "p-site",
  epic_id: "e-design",
  status_id: STATUS.todo,
  dependency_ids: [tokens.id],
  tag_ids: ["g-design"],
});
const cart = t({
  title: "Cart drawer",
  project_id: "p-site",
  epic_id: "e-shop",
  status_id: STATUS.todo,
  dependency_ids: [components.id],
  tag_ids: ["g-front"],
  due_date: iso(4),
});
const payment = t({
  title: "Stripe payment step",
  project_id: "p-site",
  epic_id: "e-shop",
  status_id: STATUS.backlog,
  dependency_ids: [cart.id],
  priority: "high",
});
const emails = t({
  title: "Order confirmation emails",
  project_id: "p-site",
  epic_id: "e-shop",
  status_id: STATUS.waiting,
  tag_ids: ["g-copy"],
});
const copy = t({
  title: "Write the landing page copy",
  project_id: "p-site",
  epic_id: "e-launch",
  status_id: STATUS.inProgress,
  tag_ids: ["g-copy"],
  today_on: iso(0),
  due_date: iso(1),
  estimate_min: 60,
});
const landing = t({
  title: "Assemble the landing page",
  project_id: "p-site",
  epic_id: "e-launch",
  status_id: STATUS.todo,
  dependency_ids: [components.id, copy.id, icons.id],
  tag_ids: ["g-front"],
});
const launch = t({
  title: "Launch day checklist",
  project_id: "p-site",
  epic_id: "e-launch",
  status_id: STATUS.backlog,
  dependency_ids: [landing.id, payment.id],
  priority: "urgent",
  due_date: iso(12),
});
const analytics = t({
  title: "Privacy-friendly analytics",
  project_id: "p-site",
  status_id: STATUS.todo,
  tag_ids: ["g-front"],
});

const outline = t({
  title: "Outline the chapters",
  project_id: "p-book",
  status_id: STATUS.done,
  completed_at: now - 8 * day,
  tag_ids: ["g-copy"],
});
const draft = t({
  title: "Draft chapter 3: mushrooms",
  project_id: "p-book",
  status_id: STATUS.inProgress,
  dependency_ids: [outline.id],
  tag_ids: ["g-copy"],
  today_on: iso(0),
  estimate_min: 90,
});
const photos = t({
  title: "Sort the autumn photos",
  project_id: "p-book",
  status_id: STATUS.todo,
  due_date: iso(-1),
});

const home = [
  t({
    title: "Book the boiler service",
    project_id: "p-home",
    status_id: STATUS.todo,
    tag_ids: ["g-errand"],
    today_on: iso(0),
    priority: "high",
  }),
  t({
    title: "Renew the passport",
    project_id: "p-home",
    status_id: STATUS.todo,
    due_date: iso(9),
  }),
  t({
    title: "Pick up the bike",
    project_id: "p-home",
    status_id: STATUS.done,
    completed_at: now - day,
    tag_ids: ["g-errand"],
  }),
];

const inbox = [
  t({ title: "Read the WebGPU article" }),
  t({ title: "Gift idea for Sam's birthday", due_date: iso(6) }),
];

export const tasks: Task[] = [
  tokens,
  components,
  icons,
  cart,
  payment,
  emails,
  copy,
  landing,
  launch,
  analytics,
  outline,
  draft,
  photos,
  ...home,
  ...inbox,
];

export function demoSnapshot(): Snapshot {
  return snapshot({ tasks, projects, epics, tags });
}
