// The @mention picker (ADR 033, T5): typing `@` in a comment, a description or a note lists
// the team's members; arrows move, Enter or Tab picks, Esc closes. Shown only when the app
// is connected to a team (there are members to mention).

import { type KeyboardEvent, type RefObject, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { type MentionAt, matchMembers, mentionAt, mentionText } from "../lib/mentions";
import { initials } from "../lib/team";
import type { Member } from "../lib/types";
import { useStoreState } from "../store/context";
import { cx, MENU } from "./ui";

/** An `@query` being typed and where to draw its list (viewport pixels). */
export interface MentionState extends MentionAt {
  left: number;
  top: number;
}

/** The members matching the query being typed, and which one is highlighted. */
export function useMentionList(query: string | null) {
  const members = useStoreState((s) => s.members);
  const list = useMemo(
    () => (query === null ? [] : matchMembers(Object.values(members), query)),
    [members, query],
  );
  const [picked, setPicked] = useState({ query, index: 0 });
  // A new query highlights the first match again.
  const active = picked.query === query ? Math.min(picked.index, list.length - 1) : 0;
  return {
    list,
    active,
    setActive: (index: number) => setPicked({ query, index }),
    /** Whether there is anyone to mention at all (the app is in a team). */
    enabled: Object.keys(members).length > 0,
  };
}

/**
 * Arrow keys, Enter, Tab and Esc while the list is open. Returns whether the key was the
 * list's (the caller then stops it).
 */
export function mentionKey(
  key: string,
  { list, active, setActive }: { list: Member[]; active: number; setActive(i: number): void },
  pick: (member: Member) => void,
  close: () => void,
): boolean {
  if (!list.length) return false;
  switch (key) {
    case "ArrowDown":
      setActive((active + 1) % list.length);
      return true;
    case "ArrowUp":
      setActive((active - 1 + list.length) % list.length);
      return true;
    case "Enter":
    case "Tab": {
      const member = list[active];
      if (member) pick(member);
      return true;
    }
    case "Escape":
      close();
      return true;
    default:
      return false;
  }
}

/** The list under the `@`; clicking a member picks it without taking the focus. */
export function MentionMenu({
  at,
  list,
  active,
  onPick,
  onHover,
}: {
  at: { left: number; top: number };
  list: Member[];
  active: number;
  onPick(member: Member): void;
  onHover(index: number): void;
}) {
  if (!list.length) return null;
  const left = Math.max(8, Math.min(at.left, window.innerWidth - 248));
  return createPortal(
    <div
      role="listbox"
      aria-label="Mention a teammate"
      style={{ left, top: at.top + 4 }}
      className={cx(MENU, "fixed w-60")}
    >
      {list.map((m, i) => (
        <div
          key={m.id}
          role="option"
          aria-selected={i === active}
          tabIndex={-1}
          data-highlighted={i === active ? "" : undefined}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(m);
          }}
          onMouseEnter={() => onHover(i)}
          className="flex min-h-8 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-1 text-sm text-ink select-none data-highlighted:bg-accent/10"
        >
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-[9px] font-semibold">
            {initials(m.name)}
          </span>
          <span className="truncate">{m.name}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/**
 * The picker for a plain textarea (comments). Wire `onSelect` and `onKeyDown` (call it
 * first: `true` means the key was the picker's) and render `menu`. The list opens under the
 * textarea. `setValue` receives the text with the mention written in.
 */
export function useTextareaMentions(
  ref: RefObject<HTMLTextAreaElement | null>,
  setValue: (text: string) => void,
) {
  const [state, setState] = useState<MentionState | null>(null);
  const mentions = useMentionList(state?.query ?? null);

  const follow = (el: HTMLTextAreaElement) => {
    const at = mentions.enabled ? mentionAt(el.value, el.selectionStart) : null;
    if (!at || el.selectionStart !== el.selectionEnd) {
      setState(null);
      return;
    }
    const box = el.getBoundingClientRect();
    setState({ ...at, left: box.left, top: box.bottom });
  };
  const close = () => setState(null);
  const pick = (member: Member) => {
    const el = ref.current;
    if (!el || !state) return;
    const insert = mentionText(member);
    const caret = state.from + insert.length;
    setValue(el.value.slice(0, state.from) + insert + el.value.slice(el.selectionStart));
    setState(null);
    // After React writes the new value.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  return {
    onSelect: (e: { currentTarget: HTMLTextAreaElement }) => follow(e.currentTarget),
    onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!state || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
      if (!mentionKey(e.key, mentions, pick, close)) return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    close,
    menu: state ? (
      <MentionMenu
        at={state}
        list={mentions.list}
        active={mentions.active}
        onPick={pick}
        onHover={mentions.setActive}
      />
    ) : null,
  };
}
