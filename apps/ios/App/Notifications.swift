import Foundation
import TaskMasterKit
import UserNotifications

/// Keeps iOS's pending notifications equal to what the core says should remind: due dates
/// and planned blocks over the coming week (docs/ios-plan.md P4). Runs after every change
/// and when the app comes back; only the difference is scheduled or removed.
@MainActor
final class Notifications {
    private let planner: ReminderPlanner
    private let center = UNUserNotificationCenter.current()
    private var observation: Session.Observation?
    /// Identifiers this app schedules start with this, so others are left alone.
    private static let prefix = "tm."

    init(session: Session) {
        planner = ReminderPlanner(session: session)
        observation = session.onDataChanged { [weak self] in
            Task { await self?.refresh() }
        }
    }

    /// Asks once for permission (the system remembers the answer), then schedules.
    func start() async {
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        await refresh()
    }

    func refresh() async {
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional,
            let wanted = try? planner.upcoming()
        else { return }
        let pending = await center.pendingNotificationRequests()
        let scheduled = Set(
            pending.map(\.identifier).filter { $0.hasPrefix(Self.prefix) }
                .map { String($0.dropFirst(Self.prefix.count)) })
        let diff = ReminderPlanner.diff(scheduled: scheduled, wanted: wanted)
        center.removePendingNotificationRequests(withIdentifiers: diff.remove.map { Self.prefix + $0 })
        for reminder in diff.add {
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.kind == .due ? "Due today" : "Planned now"
            content.sound = .default
            content.userInfo = ["task_id": reminder.taskId]
            let when = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute], from: Session.date(reminder.at))
            let request = UNNotificationRequest(
                identifier: Self.prefix + reminder.key, content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: when, repeats: false))
            try? await center.add(request)
        }
    }
}
