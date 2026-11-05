import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../components/ui";
import { toggleTaskItem } from "../../lib/attachments";
import type { Attachment } from "../../lib/types";
import { FILE_DROP_EVENT, type FileDropDetail } from "../shell/useFileDrop";
import { type MarkdownActions, MarkdownView } from "./MarkdownView";

const base = {
  "&": { backgroundColor: "transparent", color: "var(--tm-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "var(--font-sans)", caretColor: "var(--tm-accent)" },
  ".cm-cursor": { borderLeftColor: "var(--tm-accent)" },
  ".cm-placeholder": { color: "var(--tm-ink-3)", fontStyle: "italic" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--tm-accent) 25%, transparent) !important",
  },
};

const THEMES = {
  panel: EditorView.theme({
    ...base,
    "&": { ...base["&"], fontSize: "14px" },
    ".cm-content": { ...base[".cm-content"], padding: "8px 0", lineHeight: "1.55" },
    ".cm-line": { padding: "0 10px" },
  }),
  page: EditorView.theme({
    ...base,
    "&": { ...base["&"], fontSize: "17px" },
    ".cm-content": { ...base[".cm-content"], padding: "4px 0 24px", lineHeight: "1.75" },
    ".cm-line": { padding: "0" },
  }),
};

/** Turns files into attachments and returns the markdown that shows them (null: nothing). */
export interface Uploader {
  files(files: File[]): Promise<string | null>;
  paths(paths: string[]): Promise<string | null>;
}

/** `text` placed at `pos` on lines of its own. */
function insertBlock(doc: string, pos: number, text: string) {
  const before = pos > 0 && doc[pos - 1] !== "\n" ? "\n" : "";
  const after = pos < doc.length && doc[pos] !== "\n" ? "\n" : "";
  const insert = `${before}${text}${after}`;
  return { insert, cursor: pos + before.length + text.length };
}

/**
 * A task description: rendered markdown by default, CodeMirror while editing (click the
 * text or the pencil; leaving the editor or Esc saves and renders again). Pasting or
 * dropping files attaches them and inserts them at the cursor. Updates from elsewhere
 * (undo, another window) replace the text unless it is being edited.
 */
export function DescriptionEditor({
  value,
  onSave,
  size = "panel",
  attachments,
  actions,
  upload,
}: {
  value: string;
  onSave: (text: string) => void;
  /** `page`: the full task page, larger type and no frame. */
  size?: "panel" | "page";
  attachments: Record<string, Attachment>;
  actions: MarkdownActions;
  /** Absent: pasting files does nothing special. */
  upload?: Uploader;
}) {
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef(value);
  const save = useRef(onSave);
  save.current = onSave;
  const uploader = useRef(upload);
  uploader.current = upload;

  const commit = (text: string) => {
    if (text !== saved.current) {
      saved.current = text;
      save.current(text);
    }
  };

  /** Runs an upload, then inserts its markdown at the cursor (or the end when rendered). */
  const insertUploaded = async (work: Promise<string | null>, at?: number) => {
    setUploading((n) => n + 1);
    try {
      const text = await work;
      if (!text) return;
      const editor = view.current;
      if (editor) {
        const doc = editor.state.doc.toString();
        const pos = Math.min(at ?? editor.state.selection.main.head, doc.length);
        const { insert, cursor } = insertBlock(doc, pos, text);
        editor.dispatch({ changes: { from: pos, insert }, selection: { anchor: cursor } });
      } else {
        const doc = saved.current;
        commit(doc + insertBlock(doc, doc.length, text).insert);
      }
    } finally {
      setUploading((n) => n - 1);
    }
  };
  const insertRef = useRef(insertUploaded);
  insertRef.current = insertUploaded;

  // The editor exists only while editing; its size is fixed for the component's lifetime.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recreated per edit session
  useEffect(() => {
    if (!editing || !host.current) return;
    const files = (list: FileList | null | undefined) => (list ? Array.from(list) : []);
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: saved.current,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Escape",
              run: (v) => {
                v.contentDOM.blur();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          placeholder(
            size === "page"
              ? "Write freely… Markdown works: # headings, - [ ] checklists, **bold**, [links](…). Paste images to attach them."
              : "Add a description (markdown; paste images to attach them)…",
          ),
          THEMES[size],
          EditorView.domEventHandlers({
            blur: (_event, v) => {
              commit(v.state.doc.toString());
              setEditing(false);
            },
            paste: (event, v) => {
              const pasted = files(event.clipboardData?.files);
              const up = uploader.current;
              if (!pasted.length || !up) return false;
              event.preventDefault();
              void insertRef.current(up.files(pasted), v.state.selection.main.head);
              return true;
            },
            drop: (event, v) => {
              const dropped = files(event.dataTransfer?.files);
              const up = uploader.current;
              if (!dropped.length || !up) return false;
              event.preventDefault();
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
              void insertRef.current(up.files(dropped), pos ?? undefined);
              return true;
            },
          }),
        ],
      }),
    });
    view.current = editor;
    editor.focus();
    return () => {
      commit(editor.state.doc.toString());
      editor.destroy();
      view.current = null;
    };
  }, [editing]);

  // Files dropped from the OS (Tauri hands over paths, see useFileDrop).
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onDrop = (event: Event) => {
      const { paths } = (event as CustomEvent<FileDropDetail>).detail;
      const up = uploader.current;
      if (up && paths.length) void insertRef.current(up.paths(paths));
    };
    el.addEventListener(FILE_DROP_EVENT, onDrop);
    return () => el.removeEventListener(FILE_DROP_EVENT, onDrop);
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) {
      saved.current = value;
      return;
    }
    if (editor.hasFocus || value === editor.state.doc.toString()) return;
    saved.current = value;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  const page = size === "page";
  const shown = editing ? null : value.trim() ? (
    <MarkdownView
      source={value}
      attachments={attachments}
      actions={{
        ...actions,
        toggleTask: (line, checked) => commit(toggleTaskItem(saved.current, line, checked)),
      }}
      className={page ? "tm-dropcap text-[17px] leading-[1.75]" : "text-[14px] leading-[1.55]"}
    />
  ) : (
    <p className="text-ink-3 italic">
      {page ? "Write freely… Markdown works." : "Add a description…"}
    </p>
  );
  // On the page, an invitation to keep going below the text, as in the mockup.
  const more =
    page && value.trim() ? (
      <p className="mt-3 text-[17px] text-ink-3 italic">Keep writing… Markdown works.</p>
    ) : null;

  return (
    <div
      ref={frame}
      data-file-drop=""
      className={cx(
        "group relative",
        page
          ? "min-h-12"
          : "min-h-24 rounded-lg border border-line-strong bg-raised/60 focus-within:border-accent",
        "data-[drop-active]:outline-2 data-[drop-active]:outline-dashed data-[drop-active]:outline-accent",
      )}
    >
      {editing ? (
        <div ref={host} />
      ) : (
        // Clicking the text edits it; links, images, checkboxes and selections do not.
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: the pencil button is the keyboard path
        <div
          className={cx("cursor-text", page ? "py-1" : "px-2.5 py-2")}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("a, button, input, img")) return;
            if (window.getSelection()?.toString()) return;
            setEditing(true);
          }}
        >
          {shown}
          {more}
        </div>
      )}
      {!editing && (
        <button
          type="button"
          aria-label="Edit description"
          title="Edit description"
          onClick={() => setEditing(true)}
          className="absolute top-1 right-1 inline-flex size-7 items-center justify-center rounded-md text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
        >
          <Pencil size={14} />
        </button>
      )}
      {uploading > 0 && (
        <div className="absolute right-2 bottom-1 text-[12px] text-ink-3" aria-live="polite">
          Attaching…
        </div>
      )}
    </div>
  );
}
