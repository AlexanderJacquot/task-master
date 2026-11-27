// Comments on a team task (ADR 033, T5). `@Name` mentions a member (typing `@` lists them):
// they find it under "For you" on the Team page. A personal task has no comments section: the personal app
// stays as it was.

import { useMemo, useRef, useState } from "react";
import { useTextareaMentions } from "../../components/MentionMenu";
import { Button, cx, FOCUS } from "../../components/ui";
import { formatAgo } from "../../lib/dates";
import { mentionParts } from "../../lib/mentions";
import { initials, isTeamTask, memberName } from "../../lib/team";
import type { Task } from "../../lib/types";
import { addComment, deleteComment, editComment } from "../../store/actions";
import { useStoreState, useTaskStore } from "../../store/context";

export function Comments({ task }: { task: Task }) {
  const store = useTaskStore();
  const teamIds = useStoreState((s) => s.teamIds);
  const all = useStoreState((s) => s.comments);
  const members = useStoreState((s) => s.members);
  const me = useStoreState((s) => s.team?.info?.me?.id ?? null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const draftBox = useRef<HTMLTextAreaElement>(null);
  const editBox = useRef<HTMLTextAreaElement>(null);
  const draftMentions = useTextareaMentions(draftBox, setDraft);
  const editMentions = useTextareaMentions(editBox, (body) =>
    setEditing((e) => (e ? { ...e, body } : e)),
  );
  const comments = useMemo(
    () =>
      Object.values(all)
        .filter((c) => c.task_id === task.id)
        .sort((a, b) => a.created_at - b.created_at),
    [all, task.id],
  );
  const memberList = useMemo(() => Object.values(members), [members]);
  if (!isTeamTask(task, teamIds)) return null;

  const post = async () => {
    if (await addComment(store, task.id, draft)) setDraft("");
  };

  return (
    <section aria-label="Comments" className="flex flex-col gap-2">
      <h3 className="font-display text-[15px] tracking-wide text-ink-2">Comments</h3>
      {comments.map((c) => {
        const author = memberName(members, c.author_id) ?? "Someone";
        const own = c.author_id !== null && c.author_id === me;
        return (
          <article key={c.id} className="group/comment flex gap-2">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent/15 text-[10px] font-semibold text-ink">
              {initials(author)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[12px] text-ink-3">
                <span className="font-medium text-ink-2">{author}</span>
                <span>{formatAgo(c.created_at)}</span>
                {own && editing?.id !== c.id && (
                  <span className="ml-auto hidden gap-2 group-hover/comment:flex">
                    <button
                      type="button"
                      className={cx("hover:text-ink", FOCUS)}
                      onClick={() => setEditing({ id: c.id, body: c.body })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={cx("hover:text-ink", FOCUS)}
                      onClick={() => void deleteComment(store, c.id)}
                    >
                      Delete
                    </button>
                  </span>
                )}
              </div>
              {editing?.id === c.id ? (
                <textarea
                  aria-label="Edit comment"
                  // biome-ignore lint/a11y/noAutofocus: opened by the Edit button
                  autoFocus
                  value={editing.body}
                  ref={editBox}
                  onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                  onSelect={editMentions.onSelect}
                  onKeyDown={(e) => {
                    if (editMentions.onKeyDown(e)) return;
                    if (e.key === "Escape") setEditing(null);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      void editComment(store, c.id, editing.body);
                      setEditing(null);
                    }
                  }}
                  onBlur={() => {
                    editMentions.close();
                    void editComment(store, c.id, editing.body);
                    setEditing(null);
                  }}
                  className="w-full rounded-lg border border-line bg-surface p-2 text-[13px]"
                />
              ) : (
                <p className="text-[13px] whitespace-pre-wrap text-ink">
                  {mentionParts(c.body, memberList).map((part, i) =>
                    part.mention ? (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed body
                      <span key={i} className="rounded bg-accent/15 px-0.5 font-medium">
                        {part.text}
                      </span>
                    ) : (
                      // biome-ignore lint/suspicious/noArrayIndexKey: parts of one fixed body
                      <span key={i}>{part.text}</span>
                    ),
                  )}
                </p>
              )}
            </div>
          </article>
        );
      })}
      <div className="flex flex-col gap-1.5">
        <textarea
          aria-label="New comment"
          placeholder="Write a comment… type @ to mention a teammate"
          ref={draftBox}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onSelect={draftMentions.onSelect}
          onBlur={draftMentions.close}
          onKeyDown={(e) => {
            if (draftMentions.onKeyDown(e)) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void post();
          }}
          rows={2}
          className="w-full rounded-lg border border-line bg-surface p-2 text-[13px]"
        />
        {draftMentions.menu}
        {editMentions.menu}
        {draft.trim() && (
          <div>
            <Button onClick={() => void post()}>Comment</Button>
          </div>
        )}
      </div>
    </section>
  );
}
