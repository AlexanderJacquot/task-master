/** The parts of an mdast node this plugin reads. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

const NEWLINE = /[ \t]*(?:\r?\n|\r)/;

/**
 * A remark plugin: a single line return inside a paragraph renders as a line break, the way
 * people type notes (GitHub comments do the same). Plain markdown would join the lines.
 * Code blocks and inline code are other node types, so their line returns stay as they are.
 */
export function remarkBreaks() {
  return (tree: MdNode) => splitLines(tree);
}

function splitLines(node: MdNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    if (child.type !== "text" || !child.value || !NEWLINE.test(child.value)) {
      splitLines(child);
      return [child];
    }
    const out: MdNode[] = [];
    child.value.split(NEWLINE).forEach((part, i) => {
      if (i > 0) out.push({ type: "break" });
      if (part) out.push({ type: "text", value: part });
    });
    return out;
  });
}
