import SwiftUI
import TaskMasterKit

/// One scope (a project, an epic, a tag, a saved view…) as a list or as a board. A
/// project's list is cut by epic, each with its progress; other lists by status.
struct ScopeView: View {
    let session: Session
    let sync: SyncModel
    let scope: Scope
    let title: String
    @State private var list: TaskListModel
    @State private var board: BoardModel
    @State private var nav: NavigationModel
    @State private var asBoard = false

    init(session: Session, sync: SyncModel, scope: Scope, title: String) {
        self.session = session
        self.sync = sync
        self.scope = scope
        self.title = title
        _list = State(initialValue: TaskListModel(session: session, scope: scope))
        _board = State(initialValue: BoardModel(session: session, scope: scope))
        _nav = State(initialValue: NavigationModel(session: session))
    }

    var body: some View {
        List {
            Section {
                Picker("Show as", selection: $asBoard) {
                    Text("List").tag(false)
                    Text("Board").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            if asBoard {
                BoardColumnView(board: board, today: session.day.today, list: list, showProject: project == nil)
            } else if let project {
                epicSections(project)
            } else {
                statusSections
            }
            if let error = list.error ?? board.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .overlay {
            if list.tasks.isEmpty && !asBoard {
                ContentUnavailableView("No open tasks", systemImage: "checkmark.circle")
            }
        }
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { UndoMenu(list: list) }
        }
        .refreshable { await sync.syncNow() }
    }

    /// The project shown, when the scope is one.
    private var project: ProjectItem? {
        guard case .project(let id) = scope else { return nil }
        return nav.projects.first { $0.id == id }
    }

    private var subtitle: String {
        let open = list.tasks.filter { !$0.isClosed }.count
        guard let project else { return "\(open) open" }
        let epics = project.epics.filter { $0.state == .active }.count
        return epics == 0 ? "\(open) open" : "\(open) open · \(epics) \(epics == 1 ? "epic" : "epics")"
    }

    @ViewBuilder
    private func epicSections(_ project: ProjectItem) -> some View {
        let tasks = list.tasks
        ForEach(project.epics.filter { epic in tasks.contains { $0.epicId == epic.id } }) { epic in
            Section {
                rows(tasks.filter { $0.epicId == epic.id })
            } header: {
                EpicHeader(epic: epic)
            }
        }
        let loose = tasks.filter { task in
            task.epicId == nil || !project.epics.contains { $0.id == task.epicId }
        }
        if !loose.isEmpty {
            Section {
                rows(loose)
            } header: {
                SectionLabel(title: project.epics.isEmpty ? "Tasks" : "No epic", detail: "\(loose.count)")
            }
        }
    }

    @ViewBuilder
    private var statusSections: some View {
        ForEach(list.sections) { section in
            Section {
                rows(section.tasks)
            } header: {
                if !section.label.isEmpty {
                    SectionLabel(title: section.label, detail: "\(section.tasks.count)")
                }
            }
        }
    }

    private func rows(_ tasks: [TaskRow]) -> some View {
        ForEach(tasks) { task in
            TaskListRow(
                task: task, list: list, today: session.day.today, showProject: project == nil,
                showStatus: project != nil)
        }
    }
}

/// An epic over its tasks: the name, how far along it is, and a thin progress bar.
struct EpicHeader: View {
    let epic: EpicItem

    var body: some View {
        let total = epic.open + epic.done
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(epic.name).font(.title3.bold()).foregroundStyle(Theme.ink)
                Spacer()
                if total > 0 {
                    Text("\(epic.done) of \(total) done").font(.footnote).foregroundStyle(Theme.ink2)
                }
            }
            if total > 0 {
                ProgressView(value: Double(epic.done), total: Double(total))
                    .tint(Theme.done)
                    .accessibilityLabel("\(epic.done) of \(total) done")
            }
        }
        .textCase(nil)
        .padding(.top, 8)
    }
}

/// A board one column at a time: the statuses as chips, then the column's cards. A card
/// moves to another status from its menu, and within the column by dragging.
struct BoardColumnView: View {
    @Bindable var board: BoardModel
    let today: String
    let list: TaskListModel
    /// Off inside a project, where every card would name it.
    var showProject = true

    var body: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(board.columns, id: \.status.id) { column in
                        let on = column.status.id == board.column?.status.id
                        Button {
                            board.selected = column.status.id
                        } label: {
                            Chip(
                                label: "\(column.status.name) \(column.count)",
                                ink: on ? Theme.accentText : Theme.ink,
                                ground: on ? Theme.accentSoft : Theme.fill, bold: on)
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                .padding(.horizontal, 16)
            }
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            if board.column?.overLimit == true {
                Label("Over its work-in-progress limit", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(Theme.high)
            }
        }
        Section {
            if let column = board.column, column.cards.isEmpty {
                Text("Nothing in \(column.status.name).")
                    .font(.subheadline)
                    .foregroundStyle(Theme.ink2)
                    .listRowBackground(Theme.ground)
                    .listRowSeparator(.hidden)
            }
            ForEach(board.column?.cards ?? []) { card in
                TaskRowView(task: card, today: today, showProject: showProject) { list.toggle(card) }
                    .background {
                        NavigationLink(value: Route.task(id: card.id)) { EmptyView() }.opacity(0)
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
                    .listRowBackground(Theme.ground)
                    .contextMenu {
                        ForEach(board.columns, id: \.status.id) { column in
                            if column.status.id != board.column?.status.id {
                                Button("Move to \(column.status.name)") {
                                    withAnimation { board.move(card, to: column.status.id) }
                                }
                            }
                        }
                    }
            }
            .onMove { from, to in
                if let index = from.first, let card = board.column?.cards[index] {
                    board.reorder(card, to: to)
                }
            }
        }
    }
}
