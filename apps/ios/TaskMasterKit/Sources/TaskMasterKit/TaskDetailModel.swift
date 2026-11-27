import Foundation
import Observation

/// One task in full, and every edit its screen offers. Each edit is one undo step.
@MainActor
@Observable
public final class TaskDetailModel {
    public let id: String
    /// Nil once the task is gone (deleted here or elsewhere).
    public private(set) var detail: TaskDetail?
    public private(set) var activity: [ActivityItem] = []
    /// Its notes: attached ones, then those linking to it.
    public private(set) var notes: [NoteItem] = []
    public private(set) var error: String?
    /// An attachment is being downloaded.
    public private(set) var fetching: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session, id: String) {
        self.session = session
        self.id = id
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public func reload() {
        do {
            detail = try session.core.task(id: id, day: session.day)
            activity = try session.core.activity(taskId: id, limit: 50)
            notes = try session.core.taskNotes(taskId: id)
            error = nil
        } catch AppError.NotFound {
            detail = nil
            activity = []
            notes = []
        } catch {
            self.error = describe(error)
        }
    }

    /// Runs an edit, then shows its result at once (the change notice comes later).
    private func apply(_ body: () throws -> Void) {
        if let failed = failure(body) {
            error = failed
        } else {
            reload()
        }
    }

    // MARK: Fields

    public func edit(_ edits: [TaskEdit]) {
        apply { try session.core.editTask(taskId: id, edits: edits, day: session.day) }
    }

    public func setTitle(_ title: String) { edit([.title(value: title)]) }
    public func setDescription(_ text: String) { edit([.description(value: text)]) }
    public func setPriority(_ priority: Priority) { edit([.priority(value: priority)]) }
    public func setDueDate(_ date: String?) { edit([.dueDate(value: date)]) }
    public func setToday(_ on: Bool) { edit([.today(on: on)]) }
    public func setEstimate(_ minutes: Int64?) { edit([.estimate(minutes: minutes)]) }
    public func setStatus(_ statusId: String) { edit([.status(id: statusId)]) }
    /// A team member, or nobody (team tasks only).
    public func setAssignee(_ memberId: String?) { edit([.assignee(memberId: memberId)]) }

    /// Moves it to a project; an epic of another project is taken off.
    public func setProject(_ projectId: String?, epics: [EpicItem] = []) {
        var edits: [TaskEdit] = [.project(id: projectId)]
        if let epic = detail?.epicId, !epics.contains(where: { $0.id == epic }) {
            edits.append(.epic(id: nil))
        }
        edit(edits)
    }

    public func setEpic(_ epicId: String?) { edit([.epic(id: epicId)]) }

    public func setTags(_ tagIds: [String]) {
        apply { try session.core.setTags(taskId: id, tagIds: tagIds) }
    }

    public func toggleDone() {
        guard let detail else { return }
        apply { try session.core.setDone(taskId: id, done: !detail.row.stage.isClosed) }
    }

    public func delete() {
        apply { try session.core.deleteTask(taskId: id) }
    }

    // MARK: Subtasks

    /// Adds a subtask at the end. False when nothing was added.
    @discardableResult
    public func addSubtask(_ title: String) -> Bool {
        let input = NewTaskInput(
            title: title, description: "", parentId: id, projectId: nil, epicId: nil,
            statusId: nil, priority: nil, dueDate: nil, today: false, tagIds: [])
        let failed = failure { _ = try session.core.addTask(input: input, day: session.day) }
        if failed == nil { reload() } else { error = failed }
        return failed == nil
    }

    public func toggle(_ subtask: TaskRow) {
        apply { try session.core.setDone(taskId: subtask.id, done: !subtask.stage.isClosed) }
    }

    public func moveSubtask(_ subtask: TaskRow, to index: Int) {
        guard let order = detail?.subtasks.map(\.id) else { return }
        let placement = placement(of: subtask.id, at: index, in: order)
        apply { try session.core.moveTask(taskId: subtask.id, placement: placement) }
    }

    /// Makes a subtask a task of its own.
    public func detach(_ subtask: TaskRow) {
        apply { try session.core.setParent(taskId: subtask.id, parentId: nil) }
    }

    // MARK: Notes

    /// Writes a note attached to this task, titled like it. Its id, or nil when it failed.
    public func newNote() -> String? {
        guard let detail else { return nil }
        var note: String?
        apply {
            note = try session.core.createNote(
                input: NewNoteInput(title: detail.row.title, body: "", folderId: nil, taskId: id))
        }
        return note
    }

    // MARK: Attachments

    /// Copies a file (a photo, a document) into the app and attaches it.
    public func attach(_ file: URL, name: String = "") {
        apply {
            _ = try session.core.attachFile(taskId: id, path: file.path, name: name)
        }
    }

    /// The attachment's file on this phone, downloaded first when needed (network), for
    /// Quick Look. Nil when it failed or the server does not have it yet.
    public func open(_ attachment: AttachmentItem) async -> URL? {
        fetching = attachment.id
        defer { fetching = nil }
        do {
            let file = try await session.attachmentFile(attachment.id)
            error = nil
            return file
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    public func remove(_ attachment: AttachmentItem) {
        apply { try session.core.removeAttachment(id: attachment.id) }
    }

    // MARK: Time

    /// Plans time for this task.
    public func schedule(from start: Date, to end: Date) {
        apply {
            _ = try session.core.schedule(
                taskId: id, startAt: Session.ms(start), endAt: Session.ms(end))
        }
    }
}
