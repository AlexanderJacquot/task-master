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
@Test func withoutAServerTheDayPlanHasNoEvents() async throws {
    let session = try session()
    let plan = DayPlanModel(session: session)
    #expect(plan.events.isEmpty)
    await plan.refreshCalendar()
    #expect(plan.calendar.availability == .unknown)
    #expect(plan.error == nil)
}

@MainActor
@Test func withoutATeamEveryPickerIsPersonal() throws {
    let session = try session()
    let nav = NavigationModel(session: session)
    let id = try add(session, "Water the roses")
    let tag = try #require(nav.createTag("roses", for: id))
    nav.reload()
    #expect(nav.team == nil)
    #expect(nav.tags(team: false).map(\.id) == [tag])
    #expect(nav.tags(team: true).isEmpty)
    #expect(nav.statuses(team: true) == nav.statuses)
    let row = try #require(TaskDetailModel(session: session, id: id).detail?.row)
    #expect(!row.team && row.assignee == nil)
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
@Test func searchSortsByStatusAndHidesWhatIsClosed() throws {
    let session = try session()
    let done = try add(session, "Report draft")
    let doing = try add(session, "Report review")
    _ = try add(session, "Report send")
    let board = BoardModel(session: session, scope: .inbox)
    func status(_ stage: Stage) throws -> String {
        try #require(board.columns.first { $0.status.stage == stage }).status.id
    }
    let cards = board.columns.flatMap(\.cards)
    board.move(try #require(cards.first { $0.id == done }), to: try status(.done))
    board.move(try #require(cards.first { $0.id == doing }), to: try status(.inProgress))

    let defaults = try #require(UserDefaults(suiteName: "tm-search-\(UUID().uuidString)"))
    let search = SearchModel(session: session, defaults: defaults)
    search.text = "report"
    #expect(search.results.count == 3)
    search.order = .status
    #expect(search.results.map(\.title) == ["Report review", "Report send", "Report draft"])
    search.hideClosed = true
    #expect(search.results.map(\.title) == ["Report review", "Report send"])

    // The next search (the note's task picker) starts with the same settings.
    let again = SearchModel(session: session, defaults: defaults)
    #expect(again.order == .status && again.hideClosed)
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

@MainActor
@Test func theComposerPreviewsAndAddsForToday() throws {
    let session = try session()
    let capture = CaptureModel(session: session)
    #expect(capture.preview == nil && !capture.canAdd)
    capture.text = "Call the plumber #home !high ^tomorrow"
    #expect(capture.preview?.title == "Call the plumber")
    #expect(capture.preview?.tags.map(\.name) == ["home"])
    #expect(capture.preview?.priority == .high)
    #expect(capture.preview?.dueDate == "2026-11-21")
    #expect(capture.canAdd)

    capture.forToday = true
    #expect(capture.add() != nil)
    #expect(capture.text.isEmpty && capture.preview == nil)
    let today = TaskListModel(session: session, scope: .today)
    #expect(today.tasks.map(\.title) == ["Call the plumber"])
    #expect(today.tasks.first?.tags == ["home"])

    // Markers alone make nothing.
    capture.text = "#home"
    #expect(!capture.canAdd)
    #expect(capture.add() == nil && capture.error != nil)

    // The project picker decides unless the line names a project (here an unknown one,
    // so the task would have none).
    capture.text = "Fix the gate"
    #expect(capture.pickerApplies && capture.destination == nil)
    capture.text = "Fix the gate @Nowhere"
    #expect(!capture.pickerApplies && capture.destination == nil)
}

@Test func noteTextStartsAndCompletesTaskLinksAndTicksChecklists() {
    #expect(NoteText.pendingLink(in: "See [[ble") == "ble")
    #expect(NoteText.pendingLink(in: "See [[") == "")
    #expect(NoteText.pendingLink(in: "See [[done]] and more") == nil)
    #expect(NoteText.pendingLink(in: "[[ble\nnext line") == nil)
    #expect(NoteText.pendingLink(in: "no link") == nil)
    #expect(
        NoteText.completeLink(in: "See [[ble", title: "Bleed [all]", url: "task:1")
            == "See [Bleed (all)](task:1) ")
    #expect(NoteText.completeLink(in: "no link", title: "x", url: "task:1") == "no link")
    let list = "Intro\n- [ ] Clear\n  - [x] Photo"
    #expect(NoteText.toggleCheck(list, line: 1) == "Intro\n- [x] Clear\n  - [x] Photo")
    #expect(NoteText.toggleCheck(list, line: 2) == "Intro\n- [ ] Clear\n  - [ ] Photo")
    #expect(NoteText.toggleCheck(list, line: 0) == nil)
    #expect(NoteText.toggleCheck(list, line: 9) == nil)
}

@MainActor
@Test func notesAreWrittenFiledLinkedAndSaved() async throws {
    let session = try session()
    let notes = NotesModel(session: session)
    let home = try #require(notes.createFolder("Home"))
    let task = try add(session, "Bleed the radiators")
    let id = try #require(notes.create(folderId: home))
    #expect(notes.groups().map(\.name) == ["Home"])
    #expect(notes.groups().first?.notes.map(\.shownTitle) == ["Untitled"])

    let note = NoteModel(session: session, id: id)
    note.pause = .milliseconds(10)
    note.title = "Boiler"
    note.body = "Before the plumber: [[ble"
    #expect(note.linkMatches.map(\.title) == ["Bleed the radiators"])
    note.link(try #require(note.linkMatches.first))
    #expect(note.body == "Before the plumber: [Bleed the radiators](task:\(task)) ")
    #expect(note.linkMatches.isEmpty)
    // Saved after the pause (other tests share the main actor, so give it time).
    for _ in 0..<100 where note.detail?.title != "Boiler" {
        try await Task.sleep(for: .milliseconds(20))
    }
    #expect(note.error == nil)
    #expect(note.detail?.title == "Boiler")
    #expect(note.detail?.links.map(\.title) == ["Bleed the radiators"])

    // A task lists the notes that link to it; one made from a task is attached to it.
    let detail = TaskDetailModel(session: session, id: task)
    #expect(detail.notes.map(\.id) == [id])
    let ref = TaskRef(id: task, title: "Bleed the radiators", stage: .todo)
    let attached = try #require(notes.create(task: ref))
    detail.reload()
    #expect(detail.notes.map(\.id) == [attached, id])
    #expect(detail.notes.first?.title == "Bleed the radiators")
    // Left as it was made (only its title, from the task), it counts as untouched.
    let fresh = NoteModel(session: session, id: attached)
    #expect(fresh.isUntouched)
    fresh.body = "Call on Monday"
    #expect(!fresh.isUntouched)
    fresh.delete()

    note.body += "\n- [ ] Clear the cupboard"
    note.toggleCheck(line: 1)
    #expect(note.detail?.body.hasSuffix("- [x] Clear the cupboard") == true)
    note.move(to: nil)
    #expect(note.detail?.folderId == nil)
    notes.query = "cupboard"
    #expect(notes.found.map(\.id) == [id])
    note.delete()
    #expect(note.detail == nil)
    #expect(notes.error == nil && note.error == nil)
}

@MainActor
@Test func aNewProjectGoesInsideAnArea() throws {
    let session = try session()
    let nav = NavigationModel(session: session)
    let home = try #require(nav.createProject("Home", color: "#22c55e", parentId: nil))
    let garden = try #require(nav.createProject("Garden", color: nil, parentId: home))
    #expect(nav.projects.map(\.name) == ["Home", "Garden"])
    #expect(nav.projects.last?.depth == 1)
    #expect(nav.areas.map(\.id) == [home])
    #expect(nav.createProject("Beds", color: nil, parentId: garden) == nil)
    #expect(nav.error != nil)
}

@MainActor
@Test func theDockKeepsBrowseAndFourButtonsInTheirOrder() throws {
    let defaults = try #require(UserDefaults(suiteName: "tm-dock-\(UUID().uuidString)"))
    let dock = DockModel(defaults: defaults)
    #expect(dock.items == [.today, .inbox, .plan, .browse])
    #expect(dock.isFull)

    dock.add(.notes)  // full: four already
    dock.remove(.browse)  // stays
    dock.remove(.plan)
    dock.add(.project(id: "p1"))
    dock.add(.notes)  // full again
    #expect(dock.items == [.today, .inbox, .browse, .project(id: "p1")])

    dock.move(fromOffsets: [3], toOffset: 0)
    #expect(dock.items == [.project(id: "p1"), .today, .inbox, .browse])
    dock.move(fromOffsets: [0, 1], toOffset: 4)
    #expect(dock.items == [.inbox, .browse, .project(id: "p1"), .today])

    // Kept for the next launch; a deleted project's button is not shown.
    let again = DockModel(defaults: defaults)
    #expect(again.items == dock.items)
    #expect(again.shown(projectIds: []) == [.inbox, .browse, .today])

    again.reset()
    #expect(again.isStandard)
    // A saved dock that does not fit: no duplicates, Browse in, the last ones dropped.
    #expect(DockModel.valid([.notes, .notes, .today, .inbox, .plan, .allTasks, .project(id: "x")])
        == [.notes, .today, .inbox, .browse])
}
