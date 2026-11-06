import { useNavigate, useRouterState } from "@tanstack/react-router";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";
import { DeleteIcon as Trash2 } from "../../components/TaskIcons";
import { cx, MENU, MENU_DANGER, MENU_ITEM, MENU_LABEL } from "../../components/ui";
import type { Tag } from "../../lib/types";
import { deleteTag } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";

/**
 * A tag's actions (sidebar row and tag page). Deleting takes the tag off its tasks; it is
 * one batch, so Ctrl+Z brings both back. Leaves the tag's page first when it is open.
 */
export function TagMenu({
  tag,
  trigger,
  open,
  onOpenChange,
  align = "start",
}: {
  tag: Tag;
  trigger: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  align?: "start" | "end";
}) {
  const store = useTaskStore();
  const navigate = useNavigate();
  const onPage = useRouterState({
    select: (r) => r.location.pathname === `/tag/${tag.id}`,
  });
  const used = useStoreState(
    (s) => Object.values(s.tasks).filter((t) => t.tag_ids.includes(tag.id)).length,
  );
  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align={align} sideOffset={4} className={cx(MENU, "min-w-52")}>
          <DropdownMenu.Label className={MENU_LABEL}>
            #{tag.name} · {used === 1 ? "1 task" : `${used} tasks`}
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className={cx(MENU_ITEM, MENU_DANGER)}
            onSelect={() => {
              // Leave first, so the page never flashes "not found" while the tag goes.
              if (onPage) void navigate({ to: "/inbox" });
              void deleteTag(store, tag.id);
            }}
          >
            <Trash2 size={14} /> Delete tag
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
