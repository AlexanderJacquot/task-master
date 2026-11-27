# ADR 023: Files page and attachment content purge

Date: 2026-11-12 · Status: accepted (implemented on `files-page`)

## Context

Attachment content is stored by hash in each device's file folder and on the sync server.
Deleting an attachment removes its database row, but previously left its content in those
folders. Users need to see the space used and clear old, large or unused files.

## Decisions

**Show one row per content hash.** Settings → Files joins this device's stored files, the
server's stored files and live attachments. It shows size, age, task, location and whether
the file is referenced in a task description. Totals distinguish this device, the server
and content without a live attachment. The list is virtualized and can be sorted and
filtered by age, size and use. A server without the new endpoint leaves the server total
unavailable; the device list still works.

**Deletion is explicit and permanent.** A confirmation names the affected files, size,
attachments and description references. The desktop first deletes all attachments using
the chosen hashes in one undoable command batch, then purges local content. Undo restores
the attachment metadata, but cannot restore content. A description that refers to a
deleted attachment can therefore show a missing file. The UI explains both effects.

**Keep content while anything live uses it.** The core checks live attachments of live
tasks before removing content. A purge of content still in use leaves it in place and
reports it. The server's `DELETE /blobs/{hash}` returns conflict in that case.

**Propagate deletion with tombstones.** The file store keeps a marker for every purged
hash. `GET /blobs` lists server content and markers. After pushing attachment deletions,
a device sends its pending purges to the server. After pulling, a device drops local
copies marked by the server unless a live attachment here still uses them. This order
lets an attachment deletion from another device arrive before the content is considered
unused. Older servers omit these endpoints; sync of tasks and attachments still works,
but server file listings and remote purge wait for a server update.

**Backups retain their content.** Purging active stores does not remove the separate
attachment copies in local or remote backups. Recovering content requires a backup
restore or reattachment; ordinary undo does not do it.
