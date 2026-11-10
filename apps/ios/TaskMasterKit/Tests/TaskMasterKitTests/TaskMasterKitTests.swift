import Foundation
import Testing

@testable import TaskMasterKit

@MainActor
private func makeSession(_ label: String = "kit") throws -> Session {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("tm-\(label)-\(UUID().uuidString)")
    // Fixed: 10 November 2026, 09:00 in a zone one hour east of UTC.
    let now = Date(timeIntervalSince1970: 1_794_297_600)
    return try Session(
        directory: directory,
        deviceName: "Test phone",
        clock: { now },
        timeZone: { TimeZone(secondsFromGMT: 3600)! }
    )
}

@Test func theDayFollowsTheTimeZone() {
    // 23:30 UTC on 9 November.
    let late = Date(timeIntervalSince1970: 1_794_267_000)
    let utc = Session.day(at: late, in: TimeZone(secondsFromGMT: 0)!)
    #expect(utc.today == "2026-11-09")
    #expect(utc.utcOffsetMin == 0)
    let east = Session.day(at: late, in: TimeZone(secondsFromGMT: 2 * 3600)!)
    #expect(east.today == "2026-11-10")
    #expect(east.utcOffsetMin == 120)
}

@MainActor
@Test func aListShowsCapturedTasksAndTogglesThem() throws {
    let session = try makeSession()
    #expect(session.day.today == "2026-11-10")
    let inbox = TaskListModel(session: session, scope: .inbox)
    #expect(inbox.rows.isEmpty)

    #expect(inbox.add("Buy milk ^tomorrow !high"))
    #expect(inbox.add("Call the plumber"))
    #expect(!inbox.add("   "))
    #expect(inbox.error != nil)
    #expect(inbox.tasks.map(\.title) == ["Buy milk", "Call the plumber"])
    #expect(inbox.tasks[0].priority == .high)
    #expect(inbox.tasks[0].dueDate == "2026-11-11")
    guard case .group(_, let label, _, let count) = inbox.rows[0] else {
        Issue.record("a list starts with its group")
        return
    }
    #expect(label == "To do")
    #expect(count == 2)

    inbox.toggle(inbox.tasks[0])
    #expect(inbox.error == nil)
    #expect(inbox.tasks.map(\.title) == ["Call the plumber"])
    inbox.undo()
    #expect(inbox.tasks.count == 2)

    inbox.scope = .today
    #expect(inbox.tasks.isEmpty)
    inbox.scope = .all
    #expect(inbox.tasks.count == 2)
}

@MainActor
@Test func everyListHearsAboutAnEdit() async throws {
    let session = try makeSession()
    let inbox = TaskListModel(session: session, scope: .inbox)
    let all = TaskListModel(session: session, scope: .all)
    inbox.add("Seen everywhere")
    // The core reports the change from its own thread; the other list reloads on the
    // main actor shortly after.
    for _ in 0..<200 where all.tasks.isEmpty {
        try await Task.sleep(for: .milliseconds(10))
    }
    #expect(all.tasks.map(\.title) == ["Seen everywhere"])
}

@MainActor
@Test func theSyncScreenAsksForAnAddressFirst() async throws {
    let session = try makeSession()
    let sync = SyncModel(session: session)
    #expect(sync.step == .address)
    #expect(!sync.status.configured)

    await sync.connect("")
    #expect(sync.error != nil)
    #expect(!sync.busy)
    // Nothing listens there: the failure is reported, the app stays usable.
    await sync.connect("http://127.0.0.1:9")
    #expect(sync.error != nil)
    #expect(sync.step == .address)
    await sync.setToken("tm_x")
    #expect(sync.error == "connect to a server first")
}
