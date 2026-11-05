import { useMemo } from "react";
import {
  attachmentMarkdown,
  fileToBase64,
  formatSize,
  insertionText,
  MAX_ATTACHMENT_BYTES,
  pastedName,
} from "../../lib/attachments";
import type { Attachment, StoredUpload } from "../../lib/types";
import { attachFiles } from "../../store/actions";
import { useApi, useStoreState, useTaskStore } from "../../store/context";
import type { Uploader } from "./DescriptionEditor";
import type { MarkdownActions } from "./MarkdownView";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A task's attachments and what can be done with them: upload (pasted files or OS paths),
 * open, save a copy, open links. Without a `files` API (some tests) uploads do nothing.
 */
export function useTaskFiles(taskId: string) {
  const store = useTaskStore();
  const files = useApi().files;

  return useMemo(() => {
    const fail = (err: unknown) => store.setState({ lastError: message(err) });

    /** Stores each item, attaches them all in one batch; a failure reports and skips it. */
    const attach = async <T>(
      items: T[],
      put: (item: T) => Promise<StoredUpload>,
    ): Promise<Attachment[]> => {
      const stored: StoredUpload[] = [];
      for (const item of items) {
        try {
          stored.push(await put(item));
        } catch (err) {
          fail(err);
        }
      }
      return attachFiles(store, taskId, stored);
    };

    const fromFiles = (list: File[]) => {
      if (!files) return Promise.resolve([]);
      return attach(list, async (file) => {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          throw new Error(
            `${file.name || "The file"} is ${formatSize(file.size)}; attachments are limited to 50 MB`,
          );
        }
        return files.storeData(pastedName(file), file.type, await fileToBase64(file));
      });
    };

    const fromPaths = (paths: string[]) =>
      files ? attach(paths, (path) => files.storeFile(path)) : Promise.resolve([]);

    const snippet = (added: Attachment[]) =>
      added.length ? insertionText(added.map(attachmentMarkdown)) : null;

    const uploader: Uploader | undefined = files && {
      files: async (list) => snippet(await fromFiles(list)),
      paths: async (paths) => snippet(await fromPaths(paths)),
    };

    const actions: MarkdownActions = files
      ? {
          fileUrl: (id) => files.url(id),
          openAttachment: (id) => void files.open(id).catch(fail),
          openUrl: (url) => void files.openUrl(url).catch(fail),
        }
      : {};

    return {
      available: !!files,
      fromFiles,
      fromPaths,
      uploader,
      actions,
      /** Asks for files, then attaches them. */
      pick: async () => {
        if (!files) return [];
        try {
          return await fromPaths(await files.pickFiles());
        } catch (err) {
          fail(err);
          return [];
        }
      },
      saveCopy: (a: Attachment) => void files?.saveCopy(a.id, a.name).catch(fail),
    };
  }, [files, store, taskId]);
}

/** The task's attachments, oldest first. */
export function useTaskAttachments(taskId: string): Attachment[] {
  const all = useStoreState((s) => s.attachments);
  return useMemo(
    () =>
      Object.values(all)
        .filter((a) => a.task_id === taskId)
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)),
    [all, taskId],
  );
}
