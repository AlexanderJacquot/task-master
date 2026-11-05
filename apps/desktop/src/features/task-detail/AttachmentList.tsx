import {
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  MoreHorizontal,
  Paperclip,
  Pencil,
  TextCursorInput,
  Trash2,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { cx, IconButton, InlineInput } from "../../components/ui";
import { attachmentMarkdown, formatSize, isImage } from "../../lib/attachments";
import type { Attachment } from "../../lib/types";
import { deleteAttachment, renameAttachment } from "../../store/actions";
import { useTaskStore } from "../../store/context";
import { FILE_DROP_EVENT, type FileDropDetail } from "../shell/useFileDrop";
import type { useTaskFiles } from "./useTaskFiles";

const item =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink outline-none data-highlighted:bg-hover";

function Thumb({ attachment, url }: { attachment: Attachment; url?: string }) {
  const [broken, setBroken] = useState(false);
  if (isImage(attachment) && url && !broken) {
    return (
      <img
        src={url}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-9 shrink-0 rounded-md border border-line object-cover"
      />
    );
  }
  const Icon =
    attachment.mime === "application/pdf" || attachment.mime.startsWith("text/")
      ? FileText
      : FileIcon;
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-hover text-ink-3">
      <Icon size={17} />
    </span>
  );
}

/**
 * The task's files: open (click), save a copy, rename, insert into the description,
 * remove (Ctrl+Z restores). Files dropped on the section, or picked with Attach file,
 * are attached without touching the description.
 */
export function AttachmentList({
  attachments,
  files,
  onInsert,
  page,
}: {
  attachments: Attachment[];
  files: ReturnType<typeof useTaskFiles>;
  /** Adds the attachment's markdown to the end of the description. */
  onInsert: (markdown: string) => void;
  page?: boolean;
}) {
  const store = useTaskStore();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const section = useRef<HTMLElement>(null);
  const fromPaths = useRef(files.fromPaths);
  fromPaths.current = files.fromPaths;

  // Re-attached when the layout switches (the compact page line is another element).
  const compact = page === true && attachments.length === 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `compact` swaps the element
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const onDrop = (event: Event) => {
      const { paths } = (event as CustomEvent<FileDropDetail>).detail;
      setBusy(true);
      void fromPaths.current(paths).finally(() => setBusy(false));
    };
    el.addEventListener(FILE_DROP_EVENT, onDrop);
    return () => el.removeEventListener(FILE_DROP_EVENT, onDrop);
  }, [compact]);

  if (!files.available && attachments.length === 0) return null;

  const attach = files.available && (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void files.pick().finally(() => setBusy(false));
      }}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[13px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-60"
    >
      <Paperclip size={13} /> {busy ? "Attaching…" : "Attach file"}
    </button>
  );

  // The page without files: one quiet line instead of an empty section.
  if (compact) {
    return (
      <section
        ref={section}
        aria-label="Attachments"
        data-file-drop=""
        className="-ml-2 flex items-center gap-2 rounded-lg py-1 pl-10 text-ink-3 data-[drop-active]:outline-2 data-[drop-active]:outline-dashed data-[drop-active]:outline-accent"
      >
        {attach}
        <span className="text-[12.5px]">or drop files here</span>
      </section>
    );
  }

  return (
    <section
      ref={section}
      aria-label="Attachments"
      data-file-drop=""
      className={cx(
        "rounded-lg data-[drop-active]:outline-2 data-[drop-active]:outline-dashed data-[drop-active]:outline-accent",
        page && "pl-10",
      )}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={cx(
            "font-display tracking-wide",
            page ? "text-[17px] text-rubric" : "text-[14px] text-ink-2",
          )}
        >
          Attachments
        </span>
        {attachments.length > 0 && (
          <span className="text-[12px] text-ink-3">{attachments.length}</span>
        )}
        <span className="flex-1" />
        {attach}
      </div>
      {attachments.length === 0 ? (
        <p className="text-[13px] text-ink-3">
          Drop files here, or paste an image into the description.
        </p>
      ) : (
        <ul className="flex flex-col">
          {attachments.map((a) => (
            <li
              key={a.id}
              className="group flex items-center gap-2.5 rounded-lg px-1 py-1 hover:bg-hover"
            >
              <Thumb attachment={a} url={files.actions.fileUrl?.(a.id)} />
              {renaming === a.id ? (
                <InlineInput
                  initial={a.name}
                  autoFocus
                  className="min-w-0 flex-1"
                  onCommit={(name) => {
                    setRenaming(null);
                    void renameAttachment(store, a.id, name);
                  }}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => files.actions.openAttachment?.(a.id)}
                  title={`Open ${a.name}`}
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                >
                  <span className="max-w-full truncate text-[14px] text-ink group-hover:underline">
                    {a.name}
                  </span>
                  <span className="text-[12px] text-ink-3">{formatSize(a.size)}</span>
                </button>
              )}
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                  <IconButton
                    label={`Actions for ${a.name}`}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  >
                    <MoreHorizontal size={15} />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-50 min-w-48 rounded-xl border border-line-strong bg-overlay p-1 shadow-xl"
                  >
                    <DropdownMenu.Item
                      className={item}
                      onSelect={() => files.actions.openAttachment?.(a.id)}
                    >
                      <ExternalLink size={14} /> Open
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={item} onSelect={() => files.saveCopy(a)}>
                      <Download size={14} /> Save a copy…
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={item}
                      onSelect={() => onInsert(attachmentMarkdown(a))}
                    >
                      <TextCursorInput size={14} /> Insert in description
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className={item} onSelect={() => setRenaming(a.id)}>
                      <Pencil size={14} /> Rename
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className={cx(item, "text-danger")}
                      onSelect={() => void deleteAttachment(store, a.id)}
                    >
                      <Trash2 size={14} /> Remove
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
