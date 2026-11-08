import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { MoreIcon as MoreHorizontal } from "./components/TaskIcons";
import { IconButton } from "./components/ui";
import { AgentsPage } from "./features/agents/AgentsPage";
import { CalendarPage } from "./features/calendar/CalendarPage";
import { LineagePage } from "./features/lineage/LineagePage";
import { MetricsPage } from "./features/metrics/MetricsPage";
import { EpicPage } from "./features/organize/EpicPage";
import { ProjectPage } from "./features/organize/ProjectPage";
import { TagMenu } from "./features/organize/TagMenu";
import { SettingsPage } from "./features/settings/SettingsPage";
import { Layout } from "./features/shell/Layout";
import { SavedViewPage, ViewPage } from "./features/shell/ViewPage";
import { TaskPage } from "./features/task-detail/TaskDetail";
import { TodayPage } from "./features/today/TodayPage";
import { useStoreState } from "./store/context";

export type AppSearch = { task?: string; plan?: "1"; focus?: "description" };

const rootRoute = createRootRoute({
  component: Layout,
  // The detail panel is driven by ?task=<id> on every view.
  validateSearch: (search: Record<string, unknown>): AppSearch => ({
    ...(typeof search.task === "string" && { task: search.task }),
    // Opens the "Plan my day" picker on the Today view.
    ...((search.plan === "1" || search.plan === 1) && { plan: "1" as const }),
    // The task page opens with the cursor in the description (a task just created).
    ...(search.focus === "description" && { focus: "description" as const }),
  }),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/inbox" });
  },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "inbox",
  component: () => <ViewPage scope={{ kind: "inbox" }} title="Inbox" />,
});

const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "today",
  component: TodayPage,
});

const calendarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "calendar",
  component: CalendarPage,
});

const allRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "all",
  component: () => <ViewPage scope={{ kind: "all" }} title="All tasks" />,
});

const lineageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "lineage",
  // ?around=<task id> opens on one task's lineage (a task's "Lineage" button).
  validateSearch: (search: Record<string, unknown>): { around?: string } => ({
    ...(typeof search.around === "string" && { around: search.around }),
  }),
  component: function LineageView() {
    const { around } = lineageRoute.useSearch();
    // Remount per task so the selection and the fitted view start from it.
    return <LineagePage key={around ?? ""} {...(around && { around })} />;
  },
});

const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "agents",
  component: AgentsPage,
});

const metricsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "metrics",
  component: MetricsPage,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "project/$projectId",
  component: function ProjectView() {
    const { projectId } = projectRoute.useParams();
    const project = useStoreState((s) => s.projects[projectId]);
    if (!project) return <Missing what="Project" />;
    return <ProjectPage key={projectId} project={project} />;
  },
});

const epicRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "epic/$epicId",
  component: function EpicView() {
    const { epicId } = epicRoute.useParams();
    const epic = useStoreState((s) => s.epics[epicId]);
    if (!epic) return <Missing what="Epic" />;
    return <EpicPage key={epicId} epic={epic} />;
  },
});

const tagRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "tag/$tagId",
  component: function TagView() {
    const { tagId } = tagRoute.useParams();
    const tag = useStoreState((s) => s.tags[tagId]);
    if (!tag) return <Missing what="Tag" />;
    return (
      <ViewPage
        key={tagId}
        scope={{ kind: "tag", id: tagId }}
        title={`#${tag.name}`}
        actions={
          <TagMenu
            tag={tag}
            align="end"
            trigger={
              <IconButton label="More tag actions">
                <MoreHorizontal size={16} />
              </IconButton>
            }
          />
        }
      />
    );
  },
});

const savedViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "view/$viewId",
  component: function SavedView() {
    const { viewId } = savedViewRoute.useParams();
    const view = useStoreState((s) => s.views[viewId]);
    if (!view) return <Missing what="View" />;
    // Remount when the stored view changes (save, rename, undo) so the draft starts from it.
    return <SavedViewPage key={`${view.id}:${view.updated_at}`} view={view} />;
  },
});

const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "task/$taskId",
  component: function TaskView() {
    const { taskId } = taskRoute.useParams();
    const { focus } = taskRoute.useSearch();
    return <TaskPage key={taskId} taskId={taskId} focusDescription={focus === "description"} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  component: SettingsPage,
});

function Missing({ what }: { what: string }) {
  return <p className="p-8 text-ink-3">{what} not found. It may have been deleted.</p>;
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  todayRoute,
  calendarRoute,
  metricsRoute,
  lineageRoute,
  agentsRoute,
  allRoute,
  projectRoute,
  epicRoute,
  tagRoute,
  savedViewRoute,
  taskRoute,
  settingsRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  // Hash history: the Tauri webview serves one file, so reloads must not hit the server path.
  return createRouter({ routeTree, history: history ?? createHashHistory() });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
