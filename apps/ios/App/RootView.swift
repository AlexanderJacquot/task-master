import SwiftUI
import TaskMasterKit

/// The walking skeleton (docs/ios-plan.md, P1): one list with a scope switch, a capture
/// field and the sync screen. The real navigation comes with P2.
struct RootView: View {
    let session: Session
    @State private var list: TaskListModel
    @State private var sync: SyncModel
    @State private var scope = ScopeChoice.inbox
    @State private var showingSync = false
    @Environment(\.scenePhase) private var scenePhase

    init(session: Session) {
        self.session = session
        _list = State(initialValue: TaskListModel(session: session, scope: .inbox))
        _sync = State(initialValue: SyncModel(session: session))
    }

    var body: some View {
        NavigationStack {
            TaskListView(list: list, sync: sync)
                .navigationTitle(scope.title)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Picker("List", selection: $scope) {
                            ForEach(ScopeChoice.allCases) { choice in
                                Text(choice.title).tag(choice)
                            }
                        }
                        .pickerStyle(.segmented)
                        .accessibilityIdentifier("scopePicker")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showingSync = true
                        } label: {
                            Label("Sync", systemImage: syncIcon)
                        }
                        .accessibilityIdentifier("syncButton")
                    }
                }
                .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $showingSync) {
            SyncView(sync: sync)
        }
        .onChange(of: scope) { _, choice in
            list.scope = choice.scope
        }
        .onChange(of: scenePhase) { _, phase in
            // Coming back to the app: see what changed elsewhere.
            if phase == .active {
                session.core.syncKick()
                list.reload()
            }
        }
        .task {
            if let url = UITesting.serverURL {
                await sync.connect(url)
                await sync.join(.merge)
                await sync.syncNow()
            } else {
                await sync.refresh()
            }
        }
    }

    private var syncIcon: String {
        if sync.status.lastError != nil { return "exclamationmark.icloud" }
        if !sync.status.joined { return "icloud.slash" }
        return sync.status.syncing ? "arrow.triangle.2.circlepath.icloud" : "checkmark.icloud"
    }
}

enum ScopeChoice: String, CaseIterable, Identifiable {
    case inbox, today, all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .inbox: "Inbox"
        case .today: "Today"
        case .all: "All"
        }
    }

    var scope: Scope {
        switch self {
        case .inbox: .inbox
        case .today: .today
        case .all: .all
        }
    }
}
