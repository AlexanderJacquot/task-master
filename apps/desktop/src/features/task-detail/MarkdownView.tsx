import { ImageOff } from "lucide-react";
import { type ComponentProps, memo, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileTextIcon as FileText } from "../../components/TaskIcons";
import { cx } from "../../components/ui";
import { attachmentId, formatSize, isImage } from "../../lib/attachments";
import type { Attachment } from "../../lib/types";

export interface MarkdownActions {
  /** URL to load an attachment's content from. */
  fileUrl?: (id: string) => string;
  openAttachment?: (id: string) => void;
  openUrl?: (url: string) => void;
  /** A task-list checkbox on 1-based source `line` was clicked. */
  toggleTask?: (line: number, checked: boolean) => void;
}

/** Keeps `attachment:` links (resolved below) and the default safe set of URLs. */
function urlTransform(url: string): string {
  return attachmentId(url) ? url : defaultUrlTransform(url);
}

function MissingFile({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 py-1 text-[13px] text-ink-3">
      <ImageOff size={14} /> {name || "Missing attachment"}
    </span>
  );
}

function AttachmentImage({
  attachment,
  alt,
  src,
  onOpen,
}: {
  attachment: Attachment | undefined;
  alt: string;
  src: string | undefined;
  onOpen?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  if (!attachment || !src || broken) return <MissingFile name={alt} />;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${attachment.name} · ${formatSize(attachment.size)} · click to open`}
      className="block max-w-full cursor-zoom-in rounded-md"
    >
      <img
        src={src}
        alt={alt || attachment.name}
        loading="lazy"
        onError={() => setBroken(true)}
        className="max-h-[28rem] max-w-full rounded-md border border-line object-contain"
      />
    </button>
  );
}

/**
 * A task description rendered from markdown (GitHub flavor: tables, task lists,
 * strikethrough, autolinks). Raw HTML is not rendered. Images and links to
 * `attachment:<id>` show the task's files; other links open outside the app.
 */
export const MarkdownView = memo(function MarkdownView({
  source,
  attachments,
  actions,
  className,
}: {
  source: string;
  attachments: Record<string, Attachment>;
  actions: MarkdownActions;
  className?: string;
}) {
  const components: ComponentProps<typeof Markdown>["components"] = {
    img: ({ src, alt }) => {
      const id = attachmentId(typeof src === "string" ? src : null);
      if (!id) {
        // Only attachments load: remote images would leak reads and need the network.
        return <MissingFile name={alt ? `${alt} (external image)` : "External image"} />;
      }
      const attachment = attachments[id];
      return (
        <AttachmentImage
          attachment={attachment && isImage(attachment) ? attachment : undefined}
          alt={alt ?? ""}
          src={actions.fileUrl?.(id)}
          onOpen={() => actions.openAttachment?.(id)}
        />
      );
    },
    a: ({ href, children }) => {
      const id = attachmentId(href);
      if (id) {
        const attachment = attachments[id];
        return (
          <button
            type="button"
            onClick={() => attachment && actions.openAttachment?.(id)}
            className={cx(
              "inline-flex items-baseline gap-1 rounded px-0.5 text-accent hover:underline",
              !attachment && "text-ink-3 line-through",
            )}
            title={attachment ? `Open ${attachment.name}` : "This attachment was removed"}
          >
            <FileText size={13} className="self-center" />
            {children}
          </button>
        );
      }
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href) actions.openUrl?.(href);
          }}
          title={href}
        >
          {children}
        </a>
      );
    },
    // Task-list checkboxes are drawn by their list item, which knows its source line.
    input: ({ type, ...props }) => (type === "checkbox" ? null : <input type={type} {...props} />),
    li: ({ node, className, children }) => {
      if (!className?.includes("task-list-item")) return <li className={className}>{children}</li>;
      const box = node?.children.find((c) => c.type === "element" && c.tagName === "input");
      const checked = box?.type === "element" && Boolean(box.properties.checked);
      const line = node?.position?.start.line;
      return (
        <li className={className}>
          <input
            type="checkbox"
            checked={checked}
            disabled={!actions.toggleTask || line === undefined}
            onChange={(e) => line !== undefined && actions.toggleTask?.(line, e.target.checked)}
            aria-label={checked ? "Untick" : "Tick"}
          />
          {children}
        </li>
      );
    },
  };
  return (
    <div className={cx("tm-prose", className)}>
      <Markdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={components}>
        {source}
      </Markdown>
    </div>
  );
});
