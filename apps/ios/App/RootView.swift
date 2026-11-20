import SwiftUI
import TaskMasterKit

/// The home screen: one list with a scope switch, a capture field and the sync screen
/// (the walking skeleton, P1), with Browse leading to everything else. Stand-in layout
/// until the design pass.
struct RootView: View {
    let session: Session
    @State private var list: TaskListModel
    @State private var sync: SyncModel
    @State private var scope = ScopeChoice.inbox
    @State private var showingSync = false
    @State private var path: [Route] = []
    @State private var notifications: Notifications
    @Environment(\.scenePhase) private var scenePhase

    init(session: Session) {
        self.session = session
        _list = State(initialValue: TaskListModel(session: session, scope: .inbox))
        _sync = State(initialValue: SyncModel(session: session))
        _notifications = State(initialValue: Notifications(session: session))
    }

    var body: some View {
        NavigationStack(path: $path) {
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
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            path.append(.browse)
                        } label: {
                            Label("Browse", systemImage: "sidebar.left")
                        }
                        .accessibilityIdentifier("browseButton")
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
                .routes(session: session, sync: sync)
        }
        .sheet(isPresented: $showingSync) {
            SyncView(sync: sync)
        }
        .onChange(of: scope) { _, choice in
            list.scope = choice.scope
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // Coming back: pick up what extensions wrote, sync, reschedule reminders.
                session.resume()
                list.reload()
                Task { await notifications.refresh() }
            case .background:
                // Leave the database file complete before iOS suspends the app.
                session.suspend()
            default:
                break
            }
        }
        .task {
            if let url = UITesting.serverURL {
                await sync.connect(url)
                await sync.join(.merge)
                await sync.syncNow()
            } else {
                await sync.refresh()
                await notifications.start()
            }
        }
    }

    private var syncIcon: String {
        if sync.status.update != nil { return "arrow.down.app" }
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
