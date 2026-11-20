import Foundation
import Testing

@testable import TaskMasterKit

// The screen models beyond the walking skeleton (docs/ios-plan.md P2–P6), over a real
// core in a temporary folder. The Rust tests cover the rules; these cover the Swift glue.

@MainActor
private func session() throws -> Session {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("tm-plumbing-\(UUID().uuidString)")
    // 20 November 2026, 08:00 in a zone one hour east of UTC.
    let now = Date(timeIntervalSince1970: 1_795_158_000)
    return try Session(
        directory: directory, deviceName: "Test phone", clock: { now },
        timeZone: { TimeZone(secondsFromGMT: 3600)! })
}

@MainActor
private func add(_ session: Session, _ title: String) throws -> String {
    try session.core.addTask(
        input: NewTaskInput(
            title: title, description: "", parentId: nil, projectId: nil, epicId: nil,
            statusId: nil, priority: nil, dueDate: nil, today: false, tagIds: []),
        day: session.day)
}

@Test func aDropLandsBetweenItsNewNeighbours() {
    let order = ["a", "b", "c", "d"]
    // Down: SwiftUI reports the index before removal, one past the target.
    let down = placement(of: "a", at: 3, in: order)
    #expect(down.afterId == "c" && down.beforeId == "d")
    let up = placement(of: "d", at: 0, in: order)
    #expect(up.afterId == nil && up.beforeId == "a")
    let end = placement(of: "b", at: 4, in: order)
    #expect(end.afterId == "d" && end.beforeId == nil)
}

@MainActor
@Test func navigationCountsAndTags() throws {
    let session = try session()
    let nav = NavigationModel(session: session)
    #expect(nav.counts.inbox == 0)
    let id = try add(session, "Weed the beds")
    let tag = try #require(nav.createTag("#garden"))
    #expect(nav.createTag("Garden") == tag)
    try session.core.setTags(taskId: id, tagIds: [tag])
    nav.reload()
    #expect(nav.counts.inbox == 1)
    #expect(nav.tags.map(\.name) == ["garden"])
    #expect(nav.tags[0].open == 1)
    #expect(nav.statuses.contains { $0.stage == .inProgress })
    #expect(nav.error == nil)
}

@MainActor
@Test func theDetailEditsEveryField() throws {
    let session = try session()
    let id = try add(session, "Plan the garden")
    let model = TaskDetailModel(session: session, id: id)
    #expect(model.detail?.row.title == "Plan the garden")

    model.setTitle("Plan the vegetable garden")
    model.setDescription("Rows *north* to south")
    model.setPriority(.high)
    model.setDueDate("2026-12-01")
    model.setToday(true)
    model.setEstimate(30)
    model.reload()
    let detail = try #require(model.detail)
    #expect(detail.row.title == "Plan the vegetable garden")
    #expect(detail.description == "Rows *north* to south")
    #expect(detail.row.priority == .high)
    #expect(detail.row.dueDate == "2026-12-01")
    #expect(detail.row.today)
    #expect(detail.estimateMin == 30)
    #expect(model.activity.first?.kind == "update")

    model.setTitle("  ")
    #expect(model.error != nil, "a blank title is refused")

    #expect(model.addSubtask("Buy stakes"))
    #expect(model.addSubtask("Draw a map"))
    model.reload()
    #expect(model.detail?.subtasks.map(\.title) == ["Buy stakes", "Draw a map"])
    let map = try #require(model.detail?.subtasks.last)
    model.moveSubtask(map, to: 0)
    model.reload()
    #expect(model.detail?.subtasks.map(\.title) == ["Draw a map", "Buy stakes"])
    model.toggle(map)
    model.reload()
    #expect(model.detail?.row.childDone == 1)

    let inProgress = try #require(NavigationModel(session: session).statuses.first { $0.stage == .inProgress })
    model.setStatus(inProgress.id)
    model.reload()
    #expect(model.detail?.row.stage == .inProgress)

    model.delete()
    model.reload()
    #expect(model.detail == nil)
    #expect(model.error == nil)
}

@MainActor
@Test func attachmentsOpenFromThePhone() async throws {
    let session = try session()
    let id = try add(session, "Fix the fence")
    let model = TaskDetailModel(session: session, id: id)
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("fence-\(UUID()).txt")
    try Data("posts and rails".utf8).write(to: file)
    model.attach(file, name: "Fence notes.txt")
    model.reload()
    let item = try #require(model.detail?.attachments.first)
    #expect(item.name == "Fence notes.txt")
    #expect(item.onDevice)
    let opened = try #require(await model.open(item))
    #expect(try String(contentsOf: opened, encoding: .utf8) == "posts and rails")
    model.remove(item)
    model.reload()
    #expect(model.detail?.attachments.isEmpty == true)
}

@MainActor
@Test func boardsListsAndSearch() throws {
    let session = try session()
    let a = try add(session, "Alpha")
    _ = try add(session, "Bravo")
    let list = TaskListModel(session: session, scope: .inbox)
    #expect(list.tasks.map(\.title) == ["Alpha", "Bravo"])
    list.move(list.tasks[0], to: 2, in: list.sections[0])
    #expect(list.tasks.map(\.title) == ["Bravo", "Alpha"])
    list.delete(list.tasks[0])
    #expect(list.tasks.map(\.title) == ["Alpha"])
    list.undo()
    #expect(list.tasks.count == 2)
    #expect(list.undoState.canRedo)
    list.redo()
    #expect(list.tasks.count == 1)

    let board = BoardModel(session: session, scope: .inbox)
    let doing = try #require(board.columns.first { $0.status.stage == .inProgress })
    let card = try #require(board.columns.flatMap(\.cards).first { $0.id == a })
    board.move(card, to: doing.status.id)
    board.reload()
    #expect(board.columns.first { $0.status.id == doing.status.id }?.cards.map(\.id) == [a])

    let search = SearchModel(session: session)
    search.text = "alp"
    #expect(search.results.map(\.title) == ["Alpha"])
    search.text = " "
    #expect(search.results.isEmpty)
}

@MainActor
@Test func theDayPlanAndItsReminders() throws {
    let session = try session()
    let id = try add(session, "Prune the roses")
    let detail = TaskDetailModel(session: session, id: id)
    detail.setDueDate("2026-11-21")
    // 10:00 to 11:00 on the 20th, local time (UTC+1).
    let ten = Date(timeIntervalSince1970: 1_795_165_200)
    detail.schedule(from: ten, to: ten.addingTimeInterval(3600))

    let plan = DayPlanModel(session: session)
    #expect(plan.date == "2026-11-20")
    #expect(plan.blocks.map(\.title) == ["Prune the roses"])
    let block = plan.blocks[0]
    plan.move(block, start: ten.addingTimeInterval(1800), end: ten.addingTimeInterval(5400))
    #expect(plan.blocks[0].startAt == Session.ms(ten) + 1_800_000)
    plan.step(1)
    #expect(plan.date == "2026-11-21")
    #expect(plan.blocks.isEmpty)
    plan.step(-1)

    let planner = ReminderPlanner(session: session)
    let upcoming = try planner.upcoming()
    #expect(upcoming.map(\.kind) == [.block, .due])
    let diff = ReminderPlanner.diff(scheduled: [upcoming[0].key, "gone"], wanted: upcoming)
    #expect(diff.add.map(\.key) == [upcoming[1].key])
    #expect(diff.remove == ["gone"])

    plan.setOutcome(plan.blocks[0], .done)
    #expect(try planner.upcoming().map(\.kind) == [.due], "a finished block does not remind")
    plan.unschedule(plan.blocks[0])
    #expect(plan.blocks.isEmpty)
}

@MainActor
@Test func signInNeedsAServer() async throws {
    let session = try session()
    let sync = SyncModel(session: session)
    var presented = false
    await sync.signIn { url in
        presented = true
        return url
    }
    #expect(!presented)
    #expect(sync.error == "connect to a server first")
    #expect(sync.updateMessage == nil)
}
