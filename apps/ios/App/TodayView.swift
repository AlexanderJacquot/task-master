import SwiftUI
import TaskMasterKit

/// Today: what is on now (the current or next time block, leading to the plan), then what
/// is overdue, then what was picked for or falls due today, done ones last.
struct TodayView: View {
    let session: Session
    let sync: SyncModel
    let showSync: () -> Void
    let openPlan: () -> Void
    @State private var list: TaskListModel
    @State private var plan: DayPlanModel

    init(session: Session, sync: SyncModel, showSync: @escaping () -> Void, openPlan: @escaping () -> Void) {
        self.session = session
        self.sync = sync
        self.showSync = showSync
        self.openPlan = openPlan
        _list = State(initialValue: TaskListModel(session: session, scope: .today))
        _plan = State(initialValue: DayPlanModel(session: session))
    }

    var body: some View {
        let tasks = list.tasks
        let overdue = tasks.filter { $0.overdue }
        let rest = tasks.filter { !$0.overdue }
        let open = rest.filter { !$0.isClosed }
        let done = rest.filter(\.isClosed)
        List {
            if let up = UpNext(blocks: plan.blocks, events: plan.events, now: Date()) {
                Section {
                    NowCard(up: up, action: openPlan)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 4, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
            if !overdue.isEmpty {
                Section {
                    rows(overdue)
                } header: {
                    SectionLabel(title: "Overdue", detail: "\(overdue.count)", color: Theme.danger)
                }
            }
            if !open.isEmpty || !done.isEmpty {
                Section {
                    rows(open + done)
                } header: {
                    SectionLabel(
                        title: "Today",
                        detail: done.isEmpty ? "\(open.count)" : "\(open.count) open · \(done.count) done")
                }
            }
            if let error = list.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .overlay {
            if tasks.isEmpty {
                ContentUnavailableView(
                    "Nothing for today", systemImage: "sun.max",
                    description: Text("Swipe a task left to do it today, or capture one below."))
            }
        }
        .navigationTitle("Today")
        .navigationSubtitle(Date().formatted(.dateTime.weekday(.wide).day().month(.wide)))
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                SyncButton(sync: sync, action: showSync)
            }
            ToolbarItem(placement: .topBarTrailing) {
                UndoMenu(list: list)
            }
        }
        .refreshable {
            await sync.syncNow()
            await plan.refreshCalendar()
        }
        .task { await plan.refreshCalendar() }
    }

    private func rows(_ tasks: [TaskRow]) -> some View {
        ForEach(tasks) { task in
            TaskListRow(task: task, list: list, today: session.day.today)
        }
    }
}

/// The block on now, or the next one, and what follows it.
struct UpNext {
    let label: String
    let title: String
    let then: String?

    init?(blocks: [BlockItem], events: [EventItem], now: Date) {
        struct Item {
            let start: Int64
            let end: Int64
            let title: String
        }
        let ms = Session.ms(now)
        let items = (blocks.map { Item(start: $0.startAt, end: $0.endAt, title: $0.title) }
            + events.compactMap { event in
                guard let start = event.startAt, let end = event.endAt else { return nil }
                return Item(start: start, end: end, title: event.title)
            })
            .filter { $0.end > ms }
            .sorted { $0.start < $1.start }
        guard let first = items.first else { return nil }
        let on = first.start <= ms
        label = on
            ? "Now · \(clockTime(first.start)) – \(clockTime(first.end))"
            : "Next · \(clockTime(first.start)) – \(clockTime(first.end))"
        title = first.title
        then = items.dropFirst().first.map { "Then \(clockTime($0.start)) \($0.title)" }
    }
}

/// The card at the top of Today: what is on now. Tapping it opens the plan.
struct NowCard: View {
    let up: UpNext
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "clock")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 2) {
                    Text(up.label.uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accentText)
                    Text(up.title).font(.callout.weight(.semibold)).foregroundStyle(Theme.ink)
                    if let then = up.then {
                        Text(then).font(.footnote).foregroundStyle(Theme.ink2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.ink2)
            }
            .padding(14)
            .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens the day plan")
    }
}

/// How sync is doing, in the toolbar; opens the sync screen.
struct SyncButton: View {
    let sync: SyncModel
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Sync", systemImage: icon)
                .foregroundStyle(color)
        }
        .accessibilityIdentifier("syncButton")
    }

    private var icon: String {
        if sync.status.update != nil { return "arrow.down.app" }
        if sync.status.lastError != nil { return "exclamationmark.icloud" }
        if !sync.status.joined { return "icloud.slash" }
        return sync.status.syncing ? "arrow.triangle.2.circlepath.icloud" : "checkmark.icloud"
    }

    private var color: Color {
        if sync.status.lastError != nil || sync.status.update != nil { return Theme.danger }
        return sync.status.joined ? Theme.done : Theme.ink2
    }
}

/// Undo and redo for the last edits made on this phone.
struct UndoMenu: View {
    let list: TaskListModel

    var body: some View {
        let state = list.undoState
        Menu {
            Button("Undo", systemImage: "arrow.uturn.backward") { list.undo() }
                .disabled(!state.canUndo)
            Button("Redo", systemImage: "arrow.uturn.forward") { list.redo() }
                .disabled(!state.canRedo)
        } label: {
            Label("Undo", systemImage: "arrow.uturn.backward")
        } primaryAction: {
            list.undo()
        }
        .disabled(!state.canUndo && !state.canRedo)
    }
}
