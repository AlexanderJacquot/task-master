import Foundation
import Observation

/// One list of tasks (Inbox, Today, a project...): its rows, and the edits a row offers.
@MainActor
@Observable
public final class TaskListModel {
    public private(set) var rows: [ListRow] = []
    /// The last failure, in words to show; cleared by the next success.
    public private(set) var error: String?
    public var scope: Scope {
        didSet { reload() }
    }

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session, scope: Scope) {
        self.session = session
        self.scope = scope
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    /// The tasks among the rows, in order.
    public var tasks: [TaskRow] {
        rows.compactMap { row in
            if case .task(let task) = row { task } else { nil }
        }
    }

    /// A heading and the tasks under it.
    public struct Section: Identifiable, Equatable, Sendable {
        /// The group's key (a status id here).
        public let id: String
        public let label: String
        public let color: String?
        public var tasks: [TaskRow]
    }

    /// The rows as sections, for a sectioned list. Tasks before any heading (there are
    /// none today) go under an unnamed one.
    public var sections: [Section] {
        var out: [Section] = []
        for row in rows {
            switch row {
            case .group(let key, let label, let color, _):
                out.append(Section(id: key, label: label, color: color, tasks: []))
            case .task(let task):
                if out.isEmpty {
                    out.append(Section(id: "", label: "", color: nil, tasks: []))
                }
                out[out.count - 1].tasks.append(task)
            }
        }
        return out
    }

    public func reload() {
        attempt { rows = try session.core.list(scope: scope, day: session.day) }
    }

    /// Adds a task from a quick-capture line. False when nothing was added.
    @discardableResult
    public func add(_ text: String) -> Bool {
        attempt {
            _ = try session.core.capture(text: text, day: session.day)
            reload()
        }
    }

    /// Marks an open task done, or reopens a closed one.
    public func toggle(_ task: TaskRow) {
        let closed = task.stage == .done || task.stage == .cancelled
        attempt {
            try session.core.setDone(taskId: task.id, done: !closed)
            reload()
        }
    }

    /// Takes back the last edit made on this phone.
    public func undo() {
        attempt {
            _ = try session.core.undo()
            reload()
        }
    }

    @discardableResult
    private func attempt(_ body: () throws -> Void) -> Bool {
        do {
            try body()
            error = nil
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }
}
