import Foundation
import Observation

/// One day's time blocks (docs/ios-plan.md P6): move, resize, record how they went.
@MainActor
@Observable
public final class DayPlanModel {
    /// `YYYY-MM-DD`; today until changed.
    public var date: String {
        didSet { reload() }
    }
    public private(set) var blocks: [BlockItem] = []
    public private(set) var error: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session, date: String? = nil) {
        self.session = session
        self.date = date ?? session.day.today
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public func reload() {
        error = failure { blocks = try session.core.dayBlocks(date: date, day: session.day) }
    }

    /// Runs an edit, then shows its result at once (the change notice comes later).
    private func apply(_ body: () throws -> Void) {
        if let failed = failure(body) {
            error = failed
        } else {
            reload()
        }
    }

    /// Moves the shown day by `days` (negative goes back).
    public func step(_ days: Int) {
        guard let shown = DayPlanModel.parse(date),
            let next = Calendar(identifier: .gregorian).date(byAdding: .day, value: days, to: shown)
        else { return }
        date = DayPlanModel.format(next)
    }

    public func move(_ block: BlockItem, start: Date, end: Date) {
        apply {
            try session.core.moveBlock(id: block.id, startAt: Session.ms(start), endAt: Session.ms(end))
        }
    }

    public func setOutcome(_ block: BlockItem, _ outcome: Outcome) {
        apply { try session.core.setBlockOutcome(id: block.id, outcome: outcome) }
    }

    public func unschedule(_ block: BlockItem) {
        apply { try session.core.unschedule(id: block.id) }
    }

    // Dates as the core writes them, read and written in UTC so no zone shifts the day.
    private nonisolated static func formatter() -> DateFormatter {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }

    nonisolated static func parse(_ date: String) -> Date? { formatter().date(from: date) }
    nonisolated static func format(_ date: Date) -> String { formatter().string(from: date) }
}
