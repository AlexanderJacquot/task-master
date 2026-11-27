import Foundation
import Observation

/// Search over titles and descriptions, as the user types, in the order the user picked and
/// without the completed tasks if asked. The two settings are kept on the phone and shared
/// by every search (the Search tab, attaching a note to a task).
@MainActor
@Observable
public final class SearchModel {
    /// How the matches are listed. Ties keep the best match first.
    public enum Order: String, CaseIterable, Identifiable, Sendable {
        case relevance, status, due, priority, recent
        public var id: Self { self }
    }

    public var text = "" {
        didSet { reload() }
    }
    public var order: Order {
        didSet {
            defaults.set(order.rawValue, forKey: Self.orderKey)
            reload()
        }
    }
    /// Leave out done and cancelled tasks.
    public var hideClosed: Bool {
        didSet {
            defaults.set(hideClosed, forKey: Self.hideClosedKey)
            reload()
        }
    }
    public private(set) var results: [TaskRow] = []
    public private(set) var error: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var observation: Session.Observation?

    static let orderKey = "search.order"
    static let hideClosedKey = "search.hideClosed"

    public init(session: Session, defaults: UserDefaults = .standard) {
        self.session = session
        self.defaults = defaults
        order = defaults.string(forKey: Self.orderKey).flatMap(Order.init) ?? .relevance
        hideClosed = defaults.bool(forKey: Self.hideClosedKey)
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public func reload() {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            results = []
            error = nil
            return
        }
        // The core gives the 50 best matches; they are filtered and sorted here.
        error = failure {
            let matches = try session.core.search(text: text, day: session.day)
            results = Self.arrange(matches, order: order, hideClosed: hideClosed)
        }
    }

    static func arrange(_ tasks: [TaskRow], order: Order, hideClosed: Bool) -> [TaskRow] {
        let kept = hideClosed ? tasks.filter { !$0.stage.isClosed } : tasks
        guard order != .relevance else { return kept }
        return kept.enumerated().sorted { a, b in
            let (x, y) = (a.element, b.element)
            let ahead: Bool? =
                switch order {
                case .relevance: nil
                case .status: Self.rank(x.stage) == Self.rank(y.stage) ? nil : Self.rank(x.stage) < Self.rank(y.stage)
                case .priority: Self.rank(x.priority) == Self.rank(y.priority) ? nil : Self.rank(x.priority) < Self.rank(y.priority)
                // Undated last.
                case .due: x.dueDate == y.dueDate ? nil : (x.dueDate ?? "~") < (y.dueDate ?? "~")
                case .recent: x.createdAt == y.createdAt ? nil : x.createdAt > y.createdAt
                }
            return ahead ?? (a.offset < b.offset)
        }.map(\.element)
    }

    /// Under way first, then what is next, the backlog, and what is closed.
    private static func rank(_ stage: Stage) -> Int {
        switch stage {
        case .inProgress: 0
        case .todo: 1
        case .backlog: 2
        case .done: 3
        case .cancelled: 4
        }
    }

    private static func rank(_ priority: Priority) -> Int {
        switch priority {
        case .urgent: 0
        case .high: 1
        case .normal: 2
        case .low: 3
        }
    }
}
