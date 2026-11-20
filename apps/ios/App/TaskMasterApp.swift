import BackgroundTasks
import SwiftUI
import TaskMasterKit
import UserNotifications

@main
struct TaskMasterApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var launch = Launch()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            switch launch.state {
            case .ready(let session):
                RootView(session: session)
                    .onOpenURL { url in
                        if let link = AppLink(url: url) { Router.shared.open(link) }
                    }
                    // Spotlight results come back as a user activity.
                    .onContinueUserActivity(Spotlight.activityType) { activity in
                        if let id = Spotlight.taskId(in: activity) { Router.shared.open(.task(id: id)) }
                    }
            case .failed(let message):
                ContentUnavailableView(
                    "Task Master cannot open its data",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { BackgroundSync.schedule() }
        }
        // iOS wakes the app now and then (not on a schedule it promises): one sync round,
        // the reminders brought up to date, and the next wake asked for.
        .backgroundTask(.appRefresh(BackgroundSync.identifier)) {
            await BackgroundSync.run(launch)
        }
    }
}

/// Opens the database once, at launch.
@MainActor
@Observable
final class Launch {
    enum State {
        case ready(Session)
        case failed(String)
    }

    let state: State

    init() {
        do {
            let session: Session
            if UITesting.enabled {
                // UI tests ask for a fresh folder per launch.
                let dir = FileManager.default.temporaryDirectory
                    .appendingPathComponent("ui-test-\(UUID().uuidString)")
                session = try Session(directory: dir, deviceName: UIDevice.current.name)
            } else {
                session = Session(core: try SharedStore.core(deviceName: UIDevice.current.name))
            }
            try session.start()
            state = .ready(session)
        } catch {
            state = .failed((error as? AppError)?.message ?? error.localizedDescription)
        }
    }
}

/// Background app refresh (docs/ios-plan.md P4). Best effort: iOS decides when, and sync
/// on opening the app stays the guarantee.
enum BackgroundSync {
    /// Also listed under `BGTaskSchedulerPermittedIdentifiers` in project.yml.
    static let identifier = "space.solarnexus.taskmaster.sync"

    @MainActor
    static func run(_ launch: Launch) async {
        guard case .ready(let session) = launch.state else { return }
        schedule()
        _ = await session.refreshInBackground()
        await Notifications(session: session).refresh()
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// Where a link (a notification, a widget, Spotlight, a shortcut) asks the app to go.
/// The root view takes it from here.
@MainActor
@Observable
final class Router {
    static let shared = Router()
    var pending: AppLink?

    func open(_ link: AppLink) { pending = link }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Set before launch ends, so a tap that launched the app is delivered here too.
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    /// A reminder was tapped: open its task.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
    ) async {
        guard let id = response.notification.request.content.userInfo["task_id"] as? String else { return }
        await MainActor.run { Router.shared.open(.task(id: id)) }
    }

    /// A reminder due while the app is open still shows.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}

/// What the UI tests in CI ask of the app through its launch environment.
enum UITesting {
    static let environment = ProcessInfo.processInfo.environment
    static let enabled = environment["TM_UI_TEST"] == "1"
    /// A server to connect to and join at launch, without going through the sync screen.
    static let serverURL = enabled ? environment["TM_SERVER_URL"] : nil
}
