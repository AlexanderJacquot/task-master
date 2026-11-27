import Foundation
import Observation

/// A scope as a board: one column per status. The phone shows one column at a time with a
/// status switcher (docs/ios-plan.md P3); a card moves by drag or from its menu.
@MainActor
@Observable
public final class BoardModel {
    public private(set) var columns: [BoardColumn] = []
    public private(set) var error: String?
    public var scope: Scope {
        didSet { reload() }
    }
    /// The column shown (a status id); the first one until chosen.
    public var selected: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session, scope: Scope) {
        self.session = session
        self.scope = scope
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    /// The picked column; until one is picked, the first that has cards.
    public var column: BoardColumn? {
        columns.first { $0.status.id == selected } ?? columns.first { $0.count > 0 } ?? columns.first
    }

    public func reload() {
        error = failure { columns = try session.core.board(scope: scope, day: session.day) }
    }

    /// Runs an edit, then shows its result at once (the change notice comes later).
    private func apply(_ body: () throws -> Void) {
        if let failed = failure(body) {
            error = failed
        } else {
            reload()
        }
    }

    /// Moves a card to the top of another column.
    public func move(_ card: TaskRow, to statusId: String) {
        let first = columns.first { $0.status.id == statusId }?.cards.first { $0.id != card.id }
        apply {
            try session.core.moveTask(
                taskId: card.id,
                placement: Placement(statusId: statusId, afterId: nil, beforeId: first?.id))
        }
    }

    /// Moves a card within its column to `index` (as `List.onMove` reports it).
    public func reorder(_ card: TaskRow, to index: Int) {
        guard let cards = column?.cards else { return }
        let placement = placement(of: card.id, at: index, in: cards.map(\.id))
        apply { try session.core.moveTask(taskId: card.id, placement: placement) }
    }
}

/// Where `id` lands when dropped at `index` of `order` (an index from before the move,
/// as SwiftUI's `onMove` gives it): between the neighbours it ends up with.
public func placement(of id: String, at index: Int, in order: [String]) -> Placement {
    var rest = order.filter { $0 != id }
    let from = order.firstIndex(of: id) ?? rest.count
    let target = min(max(index > from ? index - 1 : index, 0), rest.count)
    rest.insert(id, at: target)
    return Placement(
        statusId: nil,
        afterId: target > 0 ? rest[target - 1] : nil,
        beforeId: target + 1 < rest.count ? rest[target + 1] : nil)
}
