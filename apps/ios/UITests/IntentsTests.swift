// AppIntentsTesting comes with the iOS 27 SDK (Xcode 27); an older Xcode (a CI runner)
// builds the other UI tests without this file.
#if canImport(AppIntentsTesting)
import AppIntentsTesting
import XCTest

/// The App Intents as Shortcuts and Siri run them: out of process, against the installed
/// app (AppIntentsTesting, iOS 27). They write the simulator's real data, so each run uses
/// a title of its own. The testing framework is iOS 27; the app supports 26.
@available(iOS 27.0, *)
final class IntentsTests: XCTestCase {
    let definitions = IntentDefinitions(bundleIdentifier: "space.solarnexus.taskmaster")

    func testAddFindAndCompleteATask() async throws {
        let title = "Intent test \(UUID().uuidString.prefix(8))"
        try await definitions.intents["AddTaskIntent"].makeIntent(text: "\(title) !high").run()

        let task = definitions.entities["TaskEntity"]
        let found = try await task.entities(matching: title)
        XCTAssertEqual(found.count, 1)
        XCTAssertEqual(try found[0].title, title)

        try await definitions.intents["CompleteTaskIntent"].makeIntent(task: found[0]).run()
        let after = try await task.entities(matching: title)
        XCTAssertTrue(after.isEmpty, "a completed task is no longer offered")
    }

    func testShowTodayOpensTheApp() async throws {
        try await definitions.intents["ShowTodayIntent"].makeIntent().run()
    }
}
#endif
