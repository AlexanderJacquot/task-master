import SwiftUI
import TaskMasterKit

/// Everything there is to open: the fixed lists, projects (in tree order, with their
/// colour) and New project, the team's, the notes by folder, epics without a project, tags
/// and saved views.
struct BrowseView: View {
    let session: Session
    let nav: NavigationModel
    let sync: SyncModel
    let showSync: () -> Void
    @State private var notes: NotesModel
    @State private var creatingProject = false
    @Environment(\.push) private var push
    @Environment(\.dock) private var dock

    init(session: Session, nav: NavigationModel, sync: SyncModel, showSync: @escaping () -> Void) {
        self.session = session
        self.nav = nav
        self.sync = sync
        self.showSync = showSync
        _notes = State(initialValue: NotesModel(session: session))
    }

    var body: some View {
        List {
            Group { sections }.listRowBackground(Theme.raised)
        }
        .scrollContentBackground(.hidden)
        .background(Theme.grouped)
        .navigationTitle("Browse")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { SyncButton(sync: sync, action: showSync) }
            ToolbarItem(placement: .topBarTrailing) {
                Button { dock.showSettings() } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
                    .accessibilityIdentifier("settings")
            }
        }
        .refreshable { await sync.syncNow() }
        .sheet(isPresented: $creatingProject) {
            NewProjectView(nav: nav) { id in
                let name = nav.projects.first { $0.id == id }?.name ?? "Project"
                push(.scope(.project(id: id), title: name))
            }
        }
    }

    @ViewBuilder
    private var sections: some View {
        Section {
            link("Inbox", .inbox, count: nav.counts.inbox, icon: "tray", tint: Theme.accentText)
            link("Today", .today, count: nav.counts.today, icon: "sun.max", tint: Theme.high)
            link("All tasks", .all, count: nil, icon: "list.bullet", tint: Theme.ink2)
        }
        projects(nav.projects(team: false), header: "Projects", canAdd: true)
        if let team = nav.team {
            // The team space (ADR 033): its projects and their epics.
            if nav.projects(team: true).isEmpty {
                Section(team.name) {
                    Text("No team projects yet").foregroundStyle(Theme.ink2)
                }
            } else {
                projects(nav.projects(team: true), header: team.name)
            }
        }
        notesSection
        if !nav.looseEpics.isEmpty {
            Section("Epics") {
                ForEach(nav.looseEpics) { epic in
                    link(epic.name, .epic(id: epic.id), count: epic.open, icon: "flag", tint: Theme.project(epic.color))
                }
            }
        }
        if !nav.tags.isEmpty {
            Section("Tags") {
                ForEach(nav.tags) { tag in
                    link("#\(tag.name)", .tag(id: tag.id), count: tag.open, icon: "number", tint: Theme.ink2)
                }
            }
        }
        if !nav.views.isEmpty {
            Section("Views") {
                ForEach(nav.views) { view in
                    link(
                        view.name, .view(id: view.id), count: nil,
                        icon: view.layout == .board ? "rectangle.split.3x1" : "line.3.horizontal",
                        tint: Theme.ink2)
                }
            }
        }
        if let error = nav.error {
            Text(error).font(.footnote).foregroundStyle(Theme.danger)
        }
    }

    private var notesSection: some View {
        Section("Notes") {
            NavigationLink(value: Route.notes(folderId: nil, title: "Notes")) {
                row("All notes", icon: "doc.text", count: notes.count)
            }
            ForEach(notes.folders) { folder in
                NavigationLink(value: Route.notes(folderId: folder.id, title: folder.name)) {
                    row(folder.name, icon: "folder", count: Int(folder.count))
                }
            }
            Button {
                if let id = notes.create() { push(.note(id: id, isNew: true)) }
            } label: {
                Label("New note", systemImage: "square.and.pencil").foregroundStyle(Theme.accentText)
            }
            .accessibilityIdentifier("browseNewNote")
        }
    }

    private func row(_ title: String, icon: String, count: Int) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).foregroundStyle(Theme.ink2).frame(width: 24)
            Text(title).foregroundStyle(Theme.ink)
            Spacer()
            if count > 0 { Text("\(count)").foregroundStyle(Theme.ink2).monospacedDigit() }
        }
    }

    @ViewBuilder
    private func projects(_ items: [ProjectItem], header: String, canAdd: Bool = false) -> some View {
        if !items.isEmpty || canAdd {
            Section(header) {
                ForEach(items) { project in
                    NavigationLink(value: Route.scope(.project(id: project.id), title: project.name)) {
                        HStack(spacing: 12) {
                            Circle().fill(Theme.project(project.color)).frame(width: 12, height: 12)
                            Text(project.name).foregroundStyle(Theme.ink)
                            Spacer()
                            if !project.epics.isEmpty {
                                Text("\(project.epics.filter { $0.state == .active }.count) epics")
                                    .font(.footnote).foregroundStyle(Theme.ink2)
                            }
                            if project.open > 0 {
                                Text("\(project.open)").foregroundStyle(Theme.ink2).monospacedDigit()
                            }
                        }
                        .padding(.leading, CGFloat(project.depth) * 20)
                    }
                }
                if canAdd {
                    Button { creatingProject = true } label: {
                        Label("New project", systemImage: "plus.circle").foregroundStyle(Theme.accentText)
                    }
                    .accessibilityIdentifier("newProject")
                }
            }
        }
    }

    private func link(_ title: String, _ scope: Scope, count: UInt32?, icon: String, tint: Color) -> some View {
        NavigationLink(value: Route.scope(scope, title: title)) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                    .frame(width: 24)
                Text(title).foregroundStyle(Theme.ink)
                Spacer()
                if let count, count > 0 {
                    Text("\(count)").foregroundStyle(Theme.ink2).monospacedDigit()
                }
            }
        }
    }
}

/// Search over every task's title and description, as you type.
struct SearchView: View {
    let session: Session
    @State private var search: SearchModel
    @State private var list: TaskListModel
    @FocusState private var fieldFocused: Bool

    init(session: Session) {
        self.session = session
        _search = State(initialValue: SearchModel(session: session))
        _list = State(initialValue: TaskListModel(session: session, scope: .all))
    }

    var body: some View {
        List {
            if !search.text.trimmingCharacters(in: .whitespaces).isEmpty {
                SearchOptionsBar(search: search)
            }
            ForEach(search.results) { task in
                TaskListRow(task: task, list: list, today: session.day.today, showStatus: true)
            }
            if let error = search.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
        }
        .listStyle(.plain)
        .overlay {
            if search.text.trimmingCharacters(in: .whitespaces).isEmpty {
                ContentUnavailableView(
                    "Search your tasks", systemImage: "magnifyingglass",
                    description: Text("Titles and notes, on this phone, offline too."))
            } else if search.results.isEmpty {
                SearchEmptyView(search: search)
            }
        }
        .searchable(text: $search.text, prompt: "Tasks")
        .searchFocused($fieldFocused)
        // Opening the tab is asking to search: the keyboard comes up with it.
        .onAppear { fieldFocused = true }
        .navigationTitle("Search")
    }
}

/// How a search lists its matches: the order, and whether completed tasks show, kept on the
/// phone for every search. A row above the results, since the search field covers the
/// navigation bar while it is active.
struct SearchOptionsBar: View {
    @Bindable var search: SearchModel

    var body: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Sort by", selection: $search.order) {
                    ForEach(SearchModel.Order.allCases) { order in
                        Label(order.title, systemImage: order.icon).tag(order)
                    }
                }
            } label: {
                option(
                    "Sort: \(search.order.title)", icon: "arrow.up.arrow.down",
                    on: search.order != .relevance)
            }
            .accessibilityLabel("Sort by \(search.order.title)")
            .accessibilityIdentifier("searchOrder")
            Button {
                search.hideClosed.toggle()
            } label: {
                option("Hide completed", icon: search.hideClosed ? "eye.slash" : "eye", on: search.hideClosed)
            }
            .accessibilityAddTraits(search.hideClosed ? .isSelected : [])
            .accessibilityIdentifier("searchHideClosed")
            Spacer(minLength: 0)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    private func option(_ text: String, icon: String, on: Bool) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote.weight(.medium))
            .lineLimit(1)
            .foregroundStyle(on ? Theme.progressInk : Theme.ink2)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(on ? Theme.progressSoft : Theme.fill, in: Capsule())
            .contentShape(Capsule())
    }
}

/// No match: says so, and offers to show the completed ones when they are hidden.
struct SearchEmptyView: View {
    @Bindable var search: SearchModel

    var body: some View {
        if search.hideClosed {
            ContentUnavailableView {
                Label("No open task", systemImage: "magnifyingglass")
            } description: {
                Text("Completed tasks are hidden.")
            } actions: {
                Button("Show completed") { search.hideClosed = false }
            }
        } else {
            ContentUnavailableView.search(text: search.text)
        }
    }
}

extension SearchModel.Order {
    var title: String {
        switch self {
        case .relevance: "Best match"
        case .status: "Status"
        case .due: "Due date"
        case .priority: "Priority"
        case .recent: "Newest"
        }
    }

    var icon: String {
        switch self {
        case .relevance: "text.magnifyingglass"
        case .status: "circle.dashed"
        case .due: "calendar"
        case .priority: "flag"
        case .recent: "clock"
        }
    }
}
