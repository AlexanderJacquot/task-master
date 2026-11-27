import SwiftUI
import TaskMasterKit

/// The tabs: the dock the user chose in Settings (Today, Inbox, Plan and Browse at first;
/// Notes, All tasks or pinned projects too), with Search as the round button beside them,
/// and the capture bar above the tab bar on every tab. Each tab keeps its own navigation
/// stack.
struct RootView: View {
    let session: Session
    @State private var sync: SyncModel
    @State private var nav: NavigationModel
    @State private var dock: DockModel
    @State private var notifications: Notifications
    @State private var spotlight: Spotlight
    @State private var tab: AppTab
    @State private var paths: [AppTab: [Route]] = [:]
    @State private var composing = false
    @State private var showingSync = false
    @State private var showingSettings = false
    private let router = Router.shared
    @Environment(\.scenePhase) private var scenePhase

    init(session: Session) {
        self.session = session
        _sync = State(initialValue: SyncModel(session: session))
        _nav = State(initialValue: NavigationModel(session: session))
        _notifications = State(initialValue: Notifications(session: session))
        _spotlight = State(initialValue: Spotlight(session: session))
        let dock = DockModel(defaults: UITesting.dockDefaults)
        _dock = State(initialValue: dock)
        _tab = State(initialValue: .item(dock.items.first ?? .today))
    }

    /// The dock's buttons that can show (a pinned project that was deleted cannot).
    private var shown: [DockItem] {
        dock.shown(projectIds: Set(nav.projects.map(\.id)))
    }

    var body: some View {
        TabView(selection: $tab) {
            ForEach(shown, id: \.self) { item in
                Tab(item.title(nav), systemImage: item.icon, value: AppTab.item(item)) {
                    stack(.item(item)) { DockScreen(item: item, session: session, sync: sync, nav: nav) }
                }
                .badge(item == .inbox ? Int(nav.counts.inbox) : 0)
            }
            Tab(value: AppTab.search, role: .search) {
                stack(.search) { SearchView(session: session) }
            }
        }
        .environment(\.dock, actions)
        .tabViewBottomAccessory {
            CaptureBar { composing = true }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tint(Theme.accent)
        .sheet(isPresented: $composing) {
            CaptureView(session: session, forToday: tab == .item(.today))
        }
        .sheet(isPresented: $showingSync) {
            SyncView(sync: sync)
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView(dock: dock, nav: nav)
        }
        // A button taken out of the dock while it was open: go to the first one.
        .onChange(of: shown) { _, items in
            if case .item(let item) = tab, !items.contains(item) {
                tab = .item(items.first ?? .browse)
            }
        }
        .onChange(of: router.pending) { _, link in
            guard let link else { return }
            router.pending = nil
            showingSync = false
            composing = false
            switch link {
            case .task(let id):
                paths[tab, default: []] = [.task(id: id)]
            case .inbox:
                open(.inbox, fresh: true)
            case .today:
                open(.today, fresh: true)
            case .dayPlan:
                open(.plan, fresh: true)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // Coming back: pick up what extensions wrote, sync, reschedule reminders.
                session.resume()
                Task { await notifications.refresh() }
                spotlight.refresh()
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

    private var actions: DockActions {
        DockActions(
            showSync: { showingSync = true },
            showSettings: { showingSettings = true },
            open: { open($0, fresh: false) })
    }

    /// Goes to a screen: its tab when it is in the dock (at its root when `fresh`), or
    /// pushed on the current tab when it is not.
    private func open(_ item: DockItem, fresh: Bool) {
        if shown.contains(item) {
            tab = .item(item)
            if fresh { paths[.item(item)] = [] }
        } else {
            paths[tab, default: []].append(.screen(item))
        }
    }

    /// A tab's navigation stack, with every screen it can push.
    private func stack<Content: View>(_ which: AppTab, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack(path: Binding(
            get: { paths[which] ?? [] },
            set: { paths[which] = $0 })
        ) {
            content().routes(session: session, sync: sync, nav: nav)
        }
        .environment(\.push, PushAction(stack: which) { paths[which, default: []].append($0) })
    }
}

enum AppTab: Hashable {
    case item(DockItem)
    case search
}

/// The bar above the tab bar: tap it to capture a task from any tab.
struct CaptureBar: View {
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 30)
                    .background(Theme.accent, in: Circle())
                Text("Add a task")
                    .foregroundStyle(Theme.ink2)
                Spacer()
            }
            .padding(.horizontal, 10)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Add a task")
        .accessibilityIdentifier("captureBar")
    }
}
