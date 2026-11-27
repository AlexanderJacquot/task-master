import Foundation
import Observation

/// One day's time blocks (docs/ios-plan.md P6): move, resize, record how they went; and
/// the day's calendar events beside them, read-only (ADR 014).
@MainActor
@Observable
public final class DayPlanModel {
    /// `YYYY-MM-DD`; today until changed.
    public var date: String {
        didSet { reload() }
    }
    public private(set) var blocks: [BlockItem] = []
    /// All-day events first, then by start.
    public private(set) var events: [EventItem] = []
    /// Where the events come from; `.onDesktop` when a desktop runs the calendar sync.
    public private(set) var calendar = CalendarInfo(
        availability: .unknown, fetchedAt: nil, lastError: nil)
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
        error = failure {
            blocks = try session.core.dayBlocks(date: date, day: session.day)
            events = try session.core.dayEvents(date: date, day: session.day)
        }
        calendar = session.core.calendarInfo()
    }

    /// Fetches the events from the server now (the day plan opened, pull to refresh).
    public func refreshCalendar() async {
        let core = session.core
        calendar = await Task.detached { core.refreshCalendar() }.value
        reload()
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
