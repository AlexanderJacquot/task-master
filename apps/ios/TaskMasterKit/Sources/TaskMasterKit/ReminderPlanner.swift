import Foundation

/// What local notifications should be pending: due dates and planned blocks over the
/// coming days (docs/ios-plan.md P4). The app hands the result to iOS, replacing what it
/// scheduled before; the keys make that a diff.
@MainActor
public struct ReminderPlanner {
    /// Minutes after midnight when a due date reminds (9:00).
    public var dueMinute: UInt32 = 9 * 60
    /// How far ahead to schedule. iOS keeps at most 64 pending notifications per app.
    public var days = 7
    public var limit = 60

    private let session: Session

    public init(session: Session) {
        self.session = session
    }

    /// The reminders from now on, soonest first.
    public func upcoming() throws -> [Reminder] {
        let now = session.nowMs
        let reminders = try session.core.reminders(
            from: now, to: now + Int64(days) * 86_400_000, dueMinute: dueMinute, day: session.day)
        return Array(reminders.prefix(limit))
    }

    /// What changes between the scheduled set (by key) and `wanted`.
    public static func diff(scheduled: Set<String>, wanted: [Reminder]) -> (add: [Reminder], remove: [String]) {
        let keys = Set(wanted.map(\.key))
        return (wanted.filter { !scheduled.contains($0.key) }, scheduled.subtracting(keys).sorted())
    }
}
