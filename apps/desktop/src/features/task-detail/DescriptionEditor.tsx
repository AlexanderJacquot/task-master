import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { useEffect, useRef } from "react";

const theme = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { fontFamily: "ui-sans-serif, system-ui, sans-serif", padding: "8px 0" },
  ".cm-line": { padding: "0 8px" },
  ".cm-placeholder": { color: "#a3a3a3" },
});

/**
 * Markdown editor (CodeMirror 6). Saves on blur and when the panel closes. Updates from
 * elsewhere (undo, another window) replace the text unless it is being edited.
 */
export function DescriptionEditor({
  value,
  onSave,
}: {
  value: string;
  onSave: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef(value);
  const save = useRef(onSave);
  save.current = onSave;

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
          placeholder("Add a description (markdown)…"),
          theme,
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
      className="min-h-24 rounded border border-neutral-200 focus-within:border-blue-500 dark:border-neutral-800"
    />
  );
}
