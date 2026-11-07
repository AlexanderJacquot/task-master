// A project's working folder on this device (ADR 017): where "Send to agent" starts its
// tasks by default. Device configuration, never synced.

import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import {
  FolderOpenIcon as FolderOpen,
  FolderClearIcon as FolderX,
} from "../../components/TaskIcons";
import { cx, IconButton, MENU, MENU_ITEM, MENU_LABEL } from "../../components/ui";
import type { ProjectFolder } from "../../lib/types";
import { useApi } from "../../store/context";

export function ProjectFolderButton({ projectId }: { projectId: string }) {
  const api = useApi().agents;
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
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

  if (!api) return null;
  const folder = folders.find((f) => f.project_id === projectId)?.path;
  const save = (path: string | null) =>
    api.setFolder(projectId, path).then(
      (f) => {
        setFolders(f);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    );

  return (
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
        <DropdownMenu.Content align="end" sideOffset={6} className={cx(MENU, "max-w-96 min-w-56")}>
          <div className={MENU_LABEL}>Folder on this device</div>
          <div className="truncate px-2.5 pb-1.5 font-mono text-[12px] text-ink-2" title={folder}>
            {folder ?? "None: Send to agent asks each time"}
          </div>
          {error && (
            <div role="alert" className="px-2.5 pb-1.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
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
  );
}
