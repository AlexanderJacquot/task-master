import SwiftUI
import TaskMasterKit

/// Where a tab's navigation stack can go.
enum Route: Hashable {
    case scope(Scope, title: String)
    case task(id: String)
    case activity(id: String)
    /// The notes, all or one folder's.
    case notes(folderId: String?, title: String)
    /// A note; a new one opens for writing and goes away if left empty.
    case note(id: String, isNew: Bool = false)
    /// A dock screen that is not in the dock (a notification opening the Inbox, Today's
    /// plan button).
    case screen(DockItem)
}

/// Opens a screen on a tab's stack. Equal for the same tab, so views reading it are not
/// redrawn each time the root view makes a new closure (SwiftUI cannot compare closures).
struct PushAction: Equatable {
    let stack: AppTab?
    let action: (Route) -> Void

    func callAsFunction(_ route: Route) { action(route) }

    static func == (lhs: PushAction, rhs: PushAction) -> Bool { lhs.stack == rhs.stack }
}

/// What the dock's screens ask of the root view. Always equal, like `PushAction`: the
/// closures only reach the root view's state.
struct DockActions: Equatable {
    var showSync: () -> Void = {}
    var showSettings: () -> Void = {}
    /// Its tab when it is in the dock, else pushed on the current tab.
    var open: (DockItem) -> Void = { _ in }

    static func == (lhs: DockActions, rhs: DockActions) -> Bool { true }
}

extension EnvironmentValues {
    /// Opens a screen on the current tab's stack (from a link in a note, a new note).
    @Entry var push = PushAction(stack: nil) { _ in }
    @Entry var dock = DockActions()
}

extension View {
    /// The destinations every screen in a stack can push.
    func routes(session: Session, sync: SyncModel, nav: NavigationModel) -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .scope(let scope, let title):
                ScopeView(session: session, sync: sync, scope: scope, title: title)
            case .task(let id):
                TaskDetailView(session: session, id: id)
            case .activity(let id):
                ActivityView(session: session, id: id)
            case .notes(let folderId, let title):
                NotesView(session: session, folderId: folderId, title: title)
            case .note(let id, let isNew):
                NoteView(session: session, id: id, isNew: isNew)
            case .screen(let item):
                DockScreen(item: item, session: session, sync: sync, nav: nav)
            }
        }
    }
}

extension Color {
    /// A `#rrggbb` color from the core, or nil.
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7,
            let value = Int(hex.dropFirst(), radix: 16)
        else { return nil }
        self.init(
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255)
    }
}

/// A time of day in the phone's zone.
func clockTime(_ ms: Int64) -> String {
    Session.date(ms).formatted(date: .omitted, time: .shortened)
}
