import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { EpicPage } from "./features/organize/EpicPage";
import { ProjectPage } from "./features/organize/ProjectPage";
import { Layout } from "./features/shell/Layout";
import { SavedViewPage, ViewPage } from "./features/shell/ViewPage";
import { useStoreState } from "./store/context";

export type AppSearch = { task?: string };

const rootRoute = createRootRoute({
  component: Layout,
  // The detail panel is driven by ?task=<id> on every view.
  validateSearch: (search: Record<string, unknown>): AppSearch =>
    typeof search.task === "string" ? { task: search.task } : {},
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
  component: () => <ViewPage scope={{ kind: "today" }} title="Today" />,
});

const allRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "all",
  component: () => <ViewPage scope={{ kind: "all" }} title="All tasks" />,
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
    return <ViewPage key={tagId} scope={{ kind: "tag", id: tagId }} title={`#${tag.name}`} />;
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

function Missing({ what }: { what: string }) {
  return <p className="p-8 text-neutral-500">{what} not found. It may have been deleted.</p>;
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  todayRoute,
  allRoute,
  projectRoute,
  epicRoute,
  tagRoute,
  savedViewRoute,
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
