import SwiftUI
import TaskMasterKit

@main
struct TaskMasterApp: App {
    @State private var launch = Launch()

    var body: some Scene {
        WindowGroup {
            switch launch.state {
            case .ready(let session):
                RootView(session: session)
            case .failed(let message):
                ContentUnavailableView(
                    "Task Master cannot open its data",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            }
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
            let session = try Session(directory: Launch.directory(), deviceName: UIDevice.current.name)
            try session.start()
            state = .ready(session)
        } catch {
            state = .failed((error as? AppError)?.message ?? error.localizedDescription)
        }
    }

    /// Application Support/TaskMaster. UI tests ask for a fresh folder per launch.
    private static func directory() throws -> URL {
        let files = FileManager.default
        if UITesting.enabled {
            return files.temporaryDirectory.appendingPathComponent("ui-test-\(UUID().uuidString)")
        }
        let support = try files.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return support.appendingPathComponent("TaskMaster")
    }
}

/// What the UI tests in CI ask of the app through its launch environment.
enum UITesting {
    static let environment = ProcessInfo.processInfo.environment
    static let enabled = environment["TM_UI_TEST"] == "1"
    /// A server to connect to and join at launch, without going through the sync screen.
    static let serverURL = enabled ? environment["TM_SERVER_URL"] : nil
}
