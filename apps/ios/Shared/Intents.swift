import AppIntents
import Foundation
import TaskMasterKit

// Shortcuts, Siri, the Action button and widget buttons (docs/ios-plan.md P5). Compiled
// into the app and the widget extension: an intent runs in whichever process asks for it,
// over that process's one core (`SharedStore`), and the app picks up the write when it
// comes back. Intent type names, the entity id and the phrases are a public contract for
// saved shortcuts: add, do not rename.

enum IntentStore {
    static func core() throws -> Core { try SharedStore.core(deviceName: "Task Master") }
    static var day: Day { Session.day(at: Date(), in: .current) }
}

/// A task, as Shortcuts and widgets refer to it. Its id is the task's UUIDv7, stable
/// across launches and devices.
struct TaskEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Task"
    static let defaultQuery = TaskQuery()

    let id: String
    @Property(title: "Title")
    var title: String

    init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)") }
}

struct TaskQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskEntity] {
        let core = try IntentStore.core()
        return identifiers.compactMap { id in
            (try? core.task(id: id, day: IntentStore.day)).map { TaskEntity(id: id, title: $0.row.title) }
        }
    }

    /// Today's open tasks: what one most likely wants to complete.
    func suggestedEntities() async throws -> [TaskEntity] {
        try IntentStore.core().list(scope: .today, day: IntentStore.day).compactMap { row in
            guard case .task(let task) = row, !task.stage.isClosed else { return nil }
            return TaskEntity(id: task.id, title: task.title)
        }
    }

    func entities(matching string: String) async throws -> [TaskEntity] {
        try IntentStore.core().search(text: string, day: IntentStore.day)
            .filter { !$0.stage.isClosed }
            .map { TaskEntity(id: $0.id, title: $0.title) }
    }
}

/// Adds a task to the Inbox from one line, read like the capture field
/// (`Buy milk ^tomorrow !high #errand`).
struct AddTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Add Task"
    static let description = IntentDescription(
        "Adds a task to the Inbox. Understands ^date, !priority, #tag and @project.")
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "Task", requestValueDialog: "What needs doing?")
    var text: String

    init() {}

    init(text: String) { self.text = text }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        _ = try IntentStore.core().capture(text: text, day: IntentStore.day)
        return .result(dialog: "Added to the Inbox.")
    }
}

/// Marks a task done (also the widget's checkbox).
struct CompleteTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Complete Task"
    static var supportedModes: IntentModes { .background }

    @Parameter(title: "Task")
    var task: TaskEntity

    init() {}

    init(task: TaskEntity) { self.task = task }

    func perform() async throws -> some IntentResult {
        try IntentStore.core().setDone(taskId: task.id, done: true)
        return .result()
    }
}

/// Opens the app on today's list.
struct ShowTodayIntent: AppIntent {
    static let title: LocalizedStringResource = "Show Today"

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(AppLink.today.url))
    }
}
