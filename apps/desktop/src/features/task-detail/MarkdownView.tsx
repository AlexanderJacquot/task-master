import { useRouter } from "@tanstack/react-router";
import { ImageOff } from "lucide-react";
import { type ComponentProps, memo, type ReactNode, useMemo, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, FileTextIcon as FileText, ScribeIcon } from "../../components/TaskIcons";
import { cx } from "../../components/ui";
import { attachmentId, formatSize, isImage } from "../../lib/attachments";
import { remarkMentions } from "../../lib/mentions";
import { entityLink } from "../../lib/notes";
import type { Attachment } from "../../lib/types";
import { useStoreState } from "../../store/context";
import { EpicMark } from "../organize/EpicMark";
import { ProjectMark } from "../organize/ProjectMark";
import { useOpenTask } from "../shell/useOpenTask";
import { remarkBreaks } from "./remarkBreaks";

export interface MarkdownActions {
  /** URL to load an attachment's content from. */
  fileUrl?: (id: string) => string;
  openAttachment?: (id: string) => void;
  openUrl?: (url: string) => void;
  /** A task-list checkbox on 1-based source `line` was clicked. */
  toggleTask?: (line: number, checked: boolean) => void;
}

/** Keeps `attachment:`, `task:`, `project:`, `epic:` and `meeting:` links (resolved below) and the default safe set of URLs. */
function urlTransform(url: string): string {
  return attachmentId(url) || entityLink(url) ? url : defaultUrlTransform(url);
}

const ENTITY_LINK =
  "inline-flex items-baseline gap-1 rounded px-1 text-accent hover:bg-accent/10 hover:underline";

/** A `task:<id>` link (ADR 032): the link text with the task's state; opens the task. */
function TaskLink({ id, children }: { id: string; children: ReactNode }) {
  const task = useStoreState((s) => s.tasks[id]);
  const done = useStoreState((s) => {
    const category = task && s.statuses.find((x) => x.id === task.status_id)?.category;
    return category === "done" || category === "cancelled";
  });
  const openTask = useOpenTask();
  return (
    <button
      type="button"
      onClick={() => task && openTask(id)}
      className={cx(ENTITY_LINK, !task && "text-ink-3 line-through", done && "text-ink-3")}
      title={task ? `Open task: ${task.title}` : "This task was deleted"}
    >
      {done ? (
        <CheckIcon size={12} className="self-center" />
      ) : (
        <span className="size-2.5 shrink-0 self-center rounded-full border-[1.5px] border-current" />
      )}
      <span className={cx(done && "line-through")}>{children}</span>
    </button>
  );
}

/** A `project:<id>` link: the link text with the project's mark; opens the project. */
function ProjectLink({ id, children }: { id: string; children: ReactNode }) {
  const project = useStoreState((s) => s.projects[id]);
  const router = useRouter({ warn: false });
  return (
    <button
      type="button"
      onClick={() =>
        project &&
        void router?.navigate({ to: "/project/$projectId", params: { projectId: id }, search: {} })
      }
      className={cx(ENTITY_LINK, !project && "text-ink-3 line-through")}
      title={project ? `Open project: ${project.name}` : "This project was deleted"}
    >
      {project && (
        <ProjectMark project={project} dotClass="size-2" className="self-center text-[12px]" />
      )}
      {children}
    </button>
  );
}

/** An `epic:<id>` link (ADR 042): the link text with the epic's mark; opens the epic. */
function EpicLink({ id, children }: { id: string; children: ReactNode }) {
  const epic = useStoreState((s) => s.epics[id]);
  const router = useRouter({ warn: false });
  return (
    <button
      type="button"
      onClick={() =>
        epic && void router?.navigate({ to: "/epic/$epicId", params: { epicId: id }, search: {} })
      }
      className={cx(ENTITY_LINK, !epic && "text-ink-3 line-through")}
      title={epic ? `Open epic: ${epic.name}` : "This epic was deleted"}
    >
      {epic && (
        <span className="self-center">
          <EpicMark epic={epic} size={12} />
        </span>
      )}
      {children}
    </button>
  );
}

/** A `meeting:<id>` link (ADR 042): the link text with the Scribe mark; opens the meeting. */
function MeetingLink({ id, children }: { id: string; children: ReactNode }) {
  const meeting = useStoreState((s) => {
    const m = s.meetings[id];
    return m && m.deleted_at === null ? m : undefined;
  });
  const router = useRouter({ warn: false });
  return (
    <button
      type="button"
      onClick={() =>
        meeting &&
        void router?.navigate({
          to: "/meeting/$meetingId",
          params: { meetingId: id },
          search: {},
        })
      }
      className={cx(ENTITY_LINK, !meeting && "text-ink-3 line-through")}
      title={meeting ? `Open meeting: ${meeting.title}` : "This meeting was deleted"}
    >
      <ScribeIcon size={12} className="shrink-0 self-center" />
      {children}
    </button>
  );
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
 * strikethrough, autolinks), where a single line return is a line break. Raw HTML is not
 * rendered. Images and links to `attachment:<id>` show the task's files; `task:<id>` and `project:<id>` links open them
 * in the app (ADR 032); other links open outside the app.
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
  // `@Name` of a team member is set apart (ADR 033).
  const members = useStoreState((s) => s.members);
  const plugins = useMemo(
    () => [remarkGfm, remarkBreaks, remarkMentions(Object.values(members))],
    [members],
  );
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
      const entity = entityLink(href);
      if (entity?.kind === "task") return <TaskLink id={entity.id}>{children}</TaskLink>;
      if (entity?.kind === "project") return <ProjectLink id={entity.id}>{children}</ProjectLink>;
      if (entity?.kind === "epic") return <EpicLink id={entity.id}>{children}</EpicLink>;
      if (entity?.kind === "meeting") return <MeetingLink id={entity.id}>{children}</MeetingLink>;
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
      <Markdown remarkPlugins={plugins} urlTransform={urlTransform} components={components}>
        {source}
      </Markdown>
    </div>
  );
});
