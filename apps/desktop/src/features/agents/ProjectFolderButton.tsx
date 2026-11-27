// A project's working folder on this device (ADR 017): where "Send to agent" starts its
// tasks by default. Device configuration, never synced. When the folder is in a git
// repository, its release (latest tag) and branch show beside the button; otherwise
// nothing git-related shows.

import { GitBranch } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import {
  FolderOpenIcon as FolderOpen,
  FolderClearIcon as FolderX,
} from "../../components/TaskIcons";
import { cx, IconButton, MENU, MENU_ITEM, MENU_LABEL, MENU_SEPARATOR } from "../../components/ui";
import type { GitInfo, ProjectFolder } from "../../lib/types";
import { useApi } from "../../store/context";
import { repoBadge, repoDetails } from "./repo";

export function ProjectFolderButton({ projectId }: { projectId: string }) {
  const api = useApi().agents;
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [repo, setRepo] = useState<GitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    api.folders().then(
      (f) => live && setFolders(f),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const folder = folders.find((f) => f.project_id === projectId)?.path;

  // Read again when the folder changes and when the window comes back to the front (a
  // commit, a checkout or a new tag happened meanwhile).
  useEffect(() => {
    if (!api || !folder) {
      setRepo(null);
      return;
    }
    let live = true;
    const read = () =>
      api.projectGit(projectId).then(
        (info) => live && setRepo(info),
        () => live && setRepo(null),
      );
    void read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, [api, projectId, folder]);

  if (!api) return null;
  const save = (path: string | null) =>
    api.setFolder(projectId, path).then(
      (f) => {
        setFolders(f);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );

  return (
    <>
      {repo && (
        <span
          className="flex h-7 max-w-64 items-center gap-1.5 truncate rounded-md px-2 font-mono text-[12px] text-ink-2"
          title={repoDetails(repo).join("\n")}
          data-testid="project-repo"
        >
          <GitBranch size={13} className="shrink-0 text-ink-3" aria-hidden />
          <span className="truncate">{repoBadge(repo)}</span>
          {repo.dirty && (
            <span className="text-ink-3" title="Uncommitted changes">
              *
            </span>
          )}
        </span>
      )}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconButton
            label={folder ? `Folder on this device: ${folder}` : "Set this project's folder"}
            className={cx(folder && "text-accent")}
          >
            <FolderOpen size={16} />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className={cx(MENU, "max-w-96 min-w-56")}
          >
            <div className={MENU_LABEL}>Folder on this device</div>
            <div className="truncate px-2.5 pb-1.5 font-mono text-[12px] text-ink-2" title={folder}>
              {folder ?? "None: Send to agent asks each time"}
            </div>
            {repo && (
              <>
                <div className={MENU_LABEL}>Git repository</div>
                <ul className="px-2.5 pb-1.5 font-mono text-[12px] text-ink-2">
                  {repoDetails(repo).map((line) => (
                    <li key={line} className="truncate" title={line}>
                      {line}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {error && (
              <div role="alert" className="px-2.5 pb-1.5 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}
            <div className={MENU_SEPARATOR} />
            <DropdownMenu.Item
              className={MENU_ITEM}
              onSelect={() => {
                void api.pickFolder().then((picked) => {
                  if (picked) void save(picked);
                });
              }}
            >
              <FolderOpen size={14} /> Choose folder…
            </DropdownMenu.Item>
            {folder && (
              <DropdownMenu.Item className={MENU_ITEM} onSelect={() => void save(null)}>
                <FolderX size={14} /> Forget folder
              </DropdownMenu.Item>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
