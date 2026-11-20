import SwiftUI
import TaskMasterKit

/// Where the navigation stack can go. Screens here are functional stand-ins: the design
/// pass (mockups first, docs/ios-plan.md section 5) replaces their look, not their models.
enum Route: Hashable {
    case browse
    case scope(Scope, title: String)
    case task(id: String)
    case dayPlan
}

extension View {
    /// The destinations every screen in the stack can push.
    func routes(session: Session, sync: SyncModel) -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .browse:
                BrowseView(session: session)
            case .scope(let scope, let title):
                ScopeView(session: session, sync: sync, scope: scope, title: title)
            case .task(let id):
                TaskDetailView(session: session, id: id)
            case .dayPlan:
                DayPlanView(session: session)
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
