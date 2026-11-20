import SwiftUI
import TaskMasterKit

/// One scope (a project, an epic, a tag, a saved view…) as a list or as a board.
struct ScopeView: View {
    let session: Session
    let sync: SyncModel
    let title: String
    @State private var list: TaskListModel
    @State private var board: BoardModel
    @State private var asBoard = false

    init(session: Session, sync: SyncModel, scope: Scope, title: String) {
        self.session = session
        self.sync = sync
        self.title = title
        _list = State(initialValue: TaskListModel(session: session, scope: scope))
        _board = State(initialValue: BoardModel(session: session, scope: scope))
    }

    var body: some View {
        Group {
            if asBoard {
                BoardView(board: board)
            } else {
                TaskListView(list: list, sync: sync)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Picker("Layout", selection: $asBoard) {
                    Label("List", systemImage: "list.bullet").tag(false)
                    Label("Board", systemImage: "rectangle.split.3x1").tag(true)
                }
                .pickerStyle(.segmented)
            }
        }
    }
}

/// A board one column at a time: a status switcher above the column's cards. A card moves
/// to another status from its menu, and within the column by dragging.
struct BoardView: View {
    @Bindable var board: BoardModel

    var body: some View {
        List {
            Section {
                Picker("Status", selection: selection) {
                    ForEach(board.columns, id: \.status.id) { column in
                        Text("\(column.status.name) \(column.count)").tag(column.status.id)
                    }
                }
                .pickerStyle(.menu)
                if board.column?.overLimit == true {
                    Label("Over its work-in-progress limit", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
            }
            Section {
                ForEach(board.column?.cards ?? []) { card in
                    NavigationLink(value: Route.task(id: card.id)) {
                        TaskRowView(task: card, toggle: {})
                    }
                    .contextMenu {
                        ForEach(board.columns, id: \.status.id) { column in
                            if column.status.id != board.column?.status.id {
                                Button("Move to \(column.status.name)") {
                                    board.move(card, to: column.status.id)
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
            if let error = board.error {
                Text(error).foregroundStyle(.red)
            }
        }
    }

    private var selection: Binding<String> {
        Binding(
            get: { board.column?.status.id ?? "" },
            set: { board.selected = $0 })
    }
}
