import Foundation
import Testing

@testable import TaskMasterKit

// What the system parts of the app rely on (docs/ios-plan.md P4–P5): links into the app,
// and the data folder shared with the extensions.

@Test func linksRoundTripAndIgnoreTheSignInCallback() throws {
    for link in [AppLink.task(id: "0190a8f2-7c1d-7000-8000-000000000001"), .inbox, .today, .dayPlan] {
        #expect(AppLink(url: link.url) == link)
    }
    #expect(AppLink.task(id: "abc").url.absoluteString == "taskmaster://task/abc")
    #expect(AppLink(url: URL(string: "taskmaster://oidc/callback?code=x")!) == nil)
    #expect(AppLink(url: URL(string: "https://example.org/task/abc")!) == nil)
    #expect(AppLink(url: URL(string: "taskmaster://task")!) == nil)
}

@Test func dataMovesIntoTheGroupContainerOnce() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("tm-group-\(UUID())")
    let group = root.appendingPathComponent("group")
    let legacy = root.appendingPathComponent("support")
    let old = legacy.appendingPathComponent("TaskMaster")
    try FileManager.default.createDirectory(
        at: old.appendingPathComponent("attachments"), withIntermediateDirectories: true)
    try Data("db".utf8).write(to: old.appendingPathComponent("tasks.sqlite"))
    try Data("{}".utf8).write(to: old.appendingPathComponent("account.json"))

    let dir = try SharedStore.directory(group: group, legacy: legacy)
    // Paths, not URLs: a URL to an existing folder gains a trailing slash.
    #expect(dir.path == group.appendingPathComponent("TaskMaster").path)
    #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("tasks.sqlite").path))
    #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("account.json").path))
    #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("attachments").path))
    #expect(!FileManager.default.fileExists(atPath: old.appendingPathComponent("tasks.sqlite").path))

    // A later build finds it in place and moves nothing back.
    try Data("stale".utf8).write(to: old.appendingPathComponent("tasks.sqlite"))
    _ = try SharedStore.directory(group: group, legacy: legacy)
    #expect(try String(contentsOf: dir.appendingPathComponent("tasks.sqlite"), encoding: .utf8) == "db")

    // Without the group (an unsigned build), the data stays in Application Support.
    #expect(try SharedStore.directory(group: nil, legacy: legacy).path == old.path)
}

@MainActor
@Test func aBackgroundRoundWithoutAServerJustSaves() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tm-bg-\(UUID())")
    let session = try Session(directory: directory, deviceName: "Test phone")
    let status = await session.refreshInBackground()
    #expect(!status.joined)
    #expect(status.lastError == nil)
}
