import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

const LINES = [1, 2, 3, 4, 5, 6].map((n) => Decoration.line({ class: `cm-md-h${n}` }));

/** The level of a markdown heading node (`ATXHeading2`, `SetextHeading1`), else 0. */
export function headingLevel(name: string): number {
  const m = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
  return m ? Number(m[1]) : 0;
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        const deco = LINES[headingLevel(node.name) - 1];
        if (!deco) return;
        // A setext heading's text is its first line; the underline keeps the body size.
        const line = view.state.doc.lineAt(node.from);
        if (line.from > last) {
          builder.add(line.from, line.from, deco);
          last = line.from;
        }
        return false;
      },
    });
  }
  return builder.finish();
}

/**
 * Sizes heading lines while editing markdown, as the rendered view does (`.cm-md-h1`…
 * in index.css, next to `.tm-prose`): CodeMirror's default style only bolds them.
 */
export const markdownHeadings = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = decorate(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
