import Foundation
import Observation

extension NoteItem: Identifiable {}
extension NoteFolderItem: Identifiable {}
extension NoteLink: Identifiable {
    public var id: String { url }
}

extension NoteItem {
    /// The title, or "Untitled" for a blank one.
    public var shownTitle: String { title.isEmpty ? "Untitled" : title }
}

/// Every note, grouped by folder, and the writes the Notes screen offers (ADR 032).
@MainActor
@Observable
public final class NotesModel {
    public struct Group: Identifiable, Equatable, Sendable {
        /// Nil: the notes outside any folder.
        public let folder: NoteFolderItem?
        public let notes: [NoteItem]
        public var id: String { folder?.id ?? "" }
        public var name: String { folder?.name ?? "No folder" }
    }

    public private(set) var folders: [NoteFolderItem] = []
    public private(set) var notes: [NoteItem] = []
    /// What the search field finds; empty while it is empty.
    public private(set) var found: [NoteItem] = []
    public var query = "" {
        didSet { search() }
    }
    public private(set) var error: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session) {
        self.session = session
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public func reload() {
        error = failure {
            let all = try session.core.notes()
            folders = all.folders
            notes = all.notes
        }
        search()
    }

    private func search() {
        let text = query.trimmingCharacters(in: .whitespaces)
        if text.isEmpty {
            found = []
        } else {
            error = failure { found = try session.core.searchNotes(text: text) }
        }
    }

    /// Folder by folder, then the notes outside any; with `folderId`, only that folder.
    /// Empty folders are kept so a new one shows.
    public func groups(in folderId: String? = nil) -> [Group] {
        let shown = folderId.map { id in folders.filter { $0.id == id } } ?? folders
        var groups = shown.map { folder in
            Group(folder: folder, notes: notes.filter { $0.folderId == folder.id })
        }
        let loose = notes.filter { $0.folderId == nil }
        if folderId == nil, !loose.isEmpty {
            groups.append(Group(folder: nil, notes: loose))
        }
        return groups
    }

    public var count: Int { notes.count }

    // MARK: Writes

    /// Runs a write, then shows its result at once (the change notice comes later).
    private func apply(_ edit: () throws -> Void) {
        if let failed = failure(edit) {
            error = failed
        } else {
            reload()
        }
    }

    /// Writes an empty note (in a folder, or attached to a task and titled like it). Its
    /// id, or nil when it failed.
    public func create(folderId: String? = nil, task: TaskRef? = nil) -> String? {
        var id: String?
        apply {
            id = try session.core.createNote(
                input: NewNoteInput(
                    title: task?.title ?? "", body: "", folderId: folderId, taskId: task?.id))
        }
        return id
    }

    public func delete(_ note: NoteItem) {
        apply { try session.core.deleteNote(id: note.id) }
    }

    public func move(_ note: NoteItem, to folderId: String?) {
        apply { try session.core.editNote(id: note.id, edits: [.folder(id: folderId)]) }
    }

    @discardableResult
    public func createFolder(_ name: String) -> String? {
        var id: String?
        apply { id = try session.core.createNoteFolder(name: name) }
        return id
    }

    public func renameFolder(_ folder: NoteFolderItem, to name: String) {
        apply { try session.core.renameNoteFolder(id: folder.id, name: name) }
    }

    /// Its notes move out of it, to the end of the top level.
    public func deleteFolder(_ folder: NoteFolderItem) {
        apply { try session.core.deleteNoteFolder(id: folder.id) }
    }
}

/// One note: what it says and links, and its edits. Typing changes `title` and `body` at
/// once and saves after a short pause (each save is one undo step, as on the desktop).
@MainActor
@Observable
public final class NoteModel {
    public let id: String
    /// Nil once the note is gone (deleted here or elsewhere).
    public private(set) var detail: NoteDetail?
    public var title = "" {
        didSet { if title != oldValue { changed() } }
    }
    public var body = "" {
        didSet { if body != oldValue { changed() } }
    }
    public private(set) var error: String?
    /// An attachment is being downloaded.
    public private(set) var fetching: String?
    /// Tasks matching the `[[` being typed.
    public private(set) var linkMatches: [TaskRow] = []

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private var loading = false
    /// The title and text when this screen first read the note.
    @ObservationIgnored private var start: (title: String, body: String)?
    /// How long typing pauses before a save.
    @ObservationIgnored public var pause: Duration = .milliseconds(700)

    public init(session: Session, id: String) {
        self.session = session
        self.id = id
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    /// Unsaved typing is kept: a change from elsewhere only refreshes what is around it.
    public func reload() {
        do {
            let fresh = try session.core.note(id: id)
            detail = fresh
            if start == nil { start = (fresh.title, fresh.body) }
            if pending == nil {
                loading = true
                title = fresh.title
                body = fresh.body
                loading = false
            }
            error = nil
        } catch AppError.NotFound {
            detail = nil
        } catch {
            self.error = describe(error)
        }
        findLinks()
    }

    private func changed() {
        findLinks()
        guard !loading else { return }
        pending?.cancel()
        pending = Task { [weak self, pause] in
            try? await Task.sleep(for: pause)
            guard !Task.isCancelled else { return }
            self?.save()
        }
    }

    /// Writes what was typed now (leaving the editor, or the app going away).
    public func save() {
        pending?.cancel()
        pending = nil
        guard let detail else { return }
        var edits: [NoteEdit] = []
        if title != detail.title { edits.append(.title(value: title)) }
        if body != detail.body { edits.append(.body(value: body)) }
        guard !edits.isEmpty else { return }
        apply { try session.core.editNote(id: id, edits: edits) }
    }

    public var isEmpty: Bool {
        title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Nothing was written since it was opened: a new note left like this is thrown away,
    /// even one titled like its task.
    public var isUntouched: Bool {
        isEmpty || (title == start?.title && body == start?.body)
    }

    private func apply(_ edit: () throws -> Void) {
        if let failed = failure(edit) {
            error = failed
        } else {
            reload()
        }
    }

    // MARK: Fields

    public func move(to folderId: String?) {
        save()
        apply { try session.core.editNote(id: id, edits: [.folder(id: folderId)]) }
    }

    /// Attaches it to a task, or detaches it with nil.
    public func attach(to taskId: String?) {
        save()
        apply { try session.core.editNote(id: id, edits: [.task(id: taskId)]) }
    }

    public func delete() {
        pending?.cancel()
        pending = nil
        apply { try session.core.deleteNote(id: id) }
    }

    /// Ticks or unticks the checklist item on that line of the text.
    public func toggleCheck(line: Int) {
        guard let toggled = NoteText.toggleCheck(body, line: line) else { return }
        body = toggled
        save()
    }

    // MARK: Links

    private func findLinks() {
        guard let typed = NoteText.pendingLink(in: body), !typed.isEmpty else {
            if !linkMatches.isEmpty { linkMatches = [] }
            return
        }
        linkMatches = (try? session.core.search(text: typed, day: session.day))
            .map { Array($0.prefix(5)) } ?? []
    }

    /// Replaces the `[[…` being typed with a link to `task`.
    public func link(_ task: TaskRow) {
        body = NoteText.completeLink(in: body, title: task.title, url: "task:\(task.id)")
        linkMatches = []
    }

    // MARK: Files

    /// Copies a photo into the app, attaches it and writes it into the text.
    public func attachPhoto(_ file: URL, name: String = "") {
        save()
        var attachment: String?
        apply {
            attachment = try session.core.attachNoteFile(noteId: id, path: file.path, name: name)
        }
        guard let attachment,
            let item = detail?.attachments.first(where: { $0.id == attachment })
        else { return }
        let embed = "![\(item.name)](attachment:\(attachment))"
        body = body.isEmpty || body.hasSuffix("\n") ? body + embed : body + "\n" + embed
        save()
    }

    /// The attachment's file on this phone, downloaded first when needed, for Quick Look.
    public func open(_ attachment: AttachmentItem) async -> URL? {
        fetching = attachment.id
        defer { fetching = nil }
        do {
            return try await session.attachmentFile(attachment.id)
        } catch {
            self.error = describe(error)
            return nil
        }
    }
}

/// Small edits on a note's markdown, kept apart to be tested.
public enum NoteText {
    /// The words after a `[[` not closed yet (at most one line and 60 characters), the
    /// way the desktop's editor starts a task link. Nil when none is being typed.
    public static func pendingLink(in text: String) -> String? {
        guard let start = text.range(of: "[[", options: .backwards) else { return nil }
        let typed = text[start.upperBound...]
        if typed.contains("\n") || typed.contains("]") || typed.count > 60 { return nil }
        return String(typed)
    }

    /// The text with its pending `[[…` replaced by `[title](url)`.
    public static func completeLink(in text: String, title: String, url: String) -> String {
        guard pendingLink(in: text) != nil,
            let start = text.range(of: "[[", options: .backwards)
        else { return text }
        let safe = title.replacingOccurrences(of: "[", with: "(")
            .replacingOccurrences(of: "]", with: ")")
        return text[..<start.lowerBound] + "[\(safe)](\(url)) "
    }

    /// The text with the checklist item on `line` (0-based) ticked or unticked; nil when
    /// that line is not one.
    public static func toggleCheck(_ text: String, line: Int) -> String? {
        var lines = text.components(separatedBy: "\n")
        guard lines.indices.contains(line) else { return nil }
        let raw = lines[line]
        let indent = raw.prefix { $0 == " " || $0 == "\t" }
        let rest = raw.dropFirst(indent.count)
        for (from, to) in [("- [ ] ", "- [x] "), ("- [x] ", "- [ ] "), ("- [X] ", "- [ ] ")]
        where rest.hasPrefix(from) {
            lines[line] = indent + to + rest.dropFirst(from.count)
            return lines.joined(separator: "\n")
        }
        return nil
    }
}
