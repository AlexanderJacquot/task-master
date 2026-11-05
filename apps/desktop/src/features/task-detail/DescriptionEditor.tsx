import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";

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

/**
 * Markdown editor (CodeMirror 6). Saves on blur and when the panel closes. Updates from
 * elsewhere (undo, another window) replace the text unless it is being edited.
 */
export function DescriptionEditor({
  value,
  onSave,
  size = "panel",
}: {
  value: string;
  onSave: (text: string) => void;
  /** `page`: the full task page, larger type and no frame. */
  size?: "panel" | "page";
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef(value);
  const save = useRef(onSave);
  save.current = onSave;

  // The size is fixed for an editor's lifetime (the panel and the page mount their own).
  // biome-ignore lint/correctness/useExhaustiveDependencies: created once; see above
  useEffect(() => {
    if (!host.current) return;
    const commit = (text: string) => {
      if (text !== saved.current) {
        saved.current = text;
        save.current(text);
      }
    };
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: saved.current,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle),
          EditorView.lineWrapping,
          placeholder(
            size === "page"
              ? "Write freely… Markdown works: # headings, - lists, **bold**, [links](…)"
              : "Add a description (markdown)…",
          ),
          THEMES[size],
          EditorView.domEventHandlers({
            blur: (_event, v) => commit(v.state.doc.toString()),
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      commit(editor.state.doc.toString());
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.hasFocus || value === editor.state.doc.toString()) return;
    saved.current = value;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      className={
        size === "page"
          ? "min-h-72"
          : "min-h-24 rounded-lg border border-line-strong bg-raised/60 focus-within:border-accent"
      }
    />
  );
}
