import SwiftUI
import TaskMasterKit

/// The app's settings: for now the dock, the buttons of the tab bar. Opened from Browse.
struct SettingsView: View {
    let dock: DockModel
    let nav: NavigationModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(dock.items, id: \.self) { item in
                        DockRow(item: item, nav: nav)
                            .deleteDisabled(!dock.canRemove(item))
                    }
                    .onMove { dock.move(fromOffsets: $0, toOffset: $1) }
                    .onDelete { offsets in
                        offsets.map { dock.items[$0] }.forEach(dock.remove)
                    }
                } header: {
                    Text("Dock")
                } footer: {
                    Text(
                        "Up to \(DockModel.maxItems) buttons beside Search; drag to reorder. Browse stays: everything else opens from it."
                    )
                }
                Section {
                    // Ids of their own: with the dock's, a screen added to the dock would keep
                    // this row's look (no remove button, no handle).
                    ForEach(DockItem.screens.filter { !dock.contains($0) }, id: \.addRowId) { item in
                        addRow(item)
                    }
                } header: {
                    Text("Screens")
                } footer: {
                    if dock.isFull { Text("The dock is full: remove a button to add another.") }
                }
                Section("Projects") {
                    let projects = nav.projects.filter { !dock.contains(.project(id: $0.id)) }
                    if projects.isEmpty {
                        Text(nav.projects.isEmpty ? "No projects yet" : "Every project is in the dock")
                            .foregroundStyle(Theme.ink2)
                    }
                    ForEach(projects) { project in
                        addRow(.project(id: project.id))
                            .padding(.leading, CGFloat(project.depth) * 20)
                    }
                }
                if !dock.isStandard {
                    Section {
                        Button("Reset the dock") { withAnimation { dock.reset() } }
                    }
                }
            }
            // Always editing: the dock's rows show their handles and remove buttons.
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.fontWeight(.semibold)
                }
            }
        }
    }

    private func addRow(_ item: DockItem) -> some View {
        Button {
            withAnimation { dock.add(item) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(dock.isFull ? Theme.ink3 : Theme.done)
                DockRow(item: item, nav: nav)
            }
        }
        .buttonStyle(.plain)
        .disabled(dock.isFull)
        .accessibilityLabel("Add \(item.title(nav)) to the dock")
    }
}

/// A dock button as a row: its icon (a project's colour) and name.
private struct DockRow: View {
    let item: DockItem
    let nav: NavigationModel

    var body: some View {
        HStack(spacing: 12) {
            if case .project(let id) = item {
                Circle()
                    .fill(Theme.project(nav.projects.first { $0.id == id }?.color))
                    .frame(width: 12, height: 12)
                    .frame(width: 24)
            } else {
                Image(systemName: item.icon).foregroundStyle(Theme.ink2).frame(width: 24)
            }
            Text(item.title(nav)).foregroundStyle(Theme.ink)
        }
    }
}

/// A dock button's screen: as a tab's root, or pushed when the button is not in the dock.
struct DockScreen: View {
    let item: DockItem
    let session: Session
    let sync: SyncModel
    let nav: NavigationModel
    @Environment(\.dock) private var dock

    var body: some View {
        switch item {
        case .today:
            TodayView(session: session, sync: sync, showSync: dock.showSync) { dock.open(.plan) }
        case .inbox:
            InboxView(session: session, nav: nav)
        case .plan:
            DayPlanView(session: session)
        case .browse:
            BrowseView(session: session, nav: nav, sync: sync, showSync: dock.showSync)
        case .notes:
            NotesView(session: session, folderId: nil, title: "Notes")
        case .allTasks:
            ScopeView(session: session, sync: sync, scope: .all, title: "All tasks")
        case .project(let id):
            ScopeView(session: session, sync: sync, scope: .project(id: id), title: item.title(nav))
        }
    }
}

extension DockItem {
    fileprivate var addRowId: String { "add \(self)" }

    @MainActor func title(_ nav: NavigationModel) -> String {
        switch self {
        case .today: "Today"
        case .inbox: "Inbox"
        case .plan: "Plan"
        case .browse: "Browse"
        case .notes: "Notes"
        case .allTasks: "All tasks"
        case .project(let id): nav.projects.first { $0.id == id }?.name ?? "Project"
        }
    }

    var icon: String {
        switch self {
        case .today: "sun.max"
        case .inbox: "tray"
        case .plan: "calendar"
        case .browse: "folder"
        case .notes: "doc.text"
        case .allTasks: "list.bullet"
        case .project: "rectangle.stack"
        }
    }
}
