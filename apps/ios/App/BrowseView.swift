import SwiftUI
import TaskMasterKit

/// Everything there is to open: the fixed lists, the day plan, projects with their epics,
/// tags and saved views; and search over all tasks.
struct BrowseView: View {
    let session: Session
    @State private var nav: NavigationModel
    @State private var search: SearchModel

    init(session: Session) {
        self.session = session
        _nav = State(initialValue: NavigationModel(session: session))
        _search = State(initialValue: SearchModel(session: session))
    }

    var body: some View {
        List {
            if search.text.trimmingCharacters(in: .whitespaces).isEmpty {
                lists
            } else {
                Section("Results") {
                    ForEach(search.results) { task in
                        NavigationLink(value: Route.task(id: task.id)) {
                            TaskRowView(task: task, toggle: {})
                        }
                    }
                }
            }
        }
        .searchable(text: $search.text, prompt: "Search tasks")
        .navigationTitle("Browse")
        .overlay(alignment: .bottom) {
            if let error = nav.error ?? search.error {
                Text(error).font(.footnote).foregroundStyle(.red).padding()
            }
        }
    }

    @ViewBuilder
    private var lists: some View {
        Section {
            link("Inbox", .inbox, count: nav.counts.inbox, icon: "tray")
            link("Today", .today, count: nav.counts.today, icon: "sun.max")
            link("All", .all, count: nil, icon: "list.bullet")
            NavigationLink(value: Route.dayPlan) {
                Label("Day plan", systemImage: "calendar.day.timeline.left")
            }
            if nav.counts.overdue > 0 {
                Label("\(nav.counts.overdue) overdue", systemImage: "exclamationmark.circle")
                    .foregroundStyle(.red)
            }
        }
        if !nav.projects.isEmpty {
            Section("Projects") {
                ForEach(nav.projects) { project in
                    link(project.name, .project(id: project.id), count: project.open, icon: "folder")
                        .padding(.leading, CGFloat(project.depth) * 16)
                        .tint(Color(hex: project.color) ?? .accentColor)
                    ForEach(project.epics) { epic in
                        epicLink(epic).padding(.leading, CGFloat(project.depth + 1) * 16)
                    }
                }
            }
        }
        if !nav.looseEpics.isEmpty {
            Section("Epics") {
                ForEach(nav.looseEpics) { epicLink($0) }
            }
        }
        if !nav.tags.isEmpty {
            Section("Tags") {
                ForEach(nav.tags) { tag in
                    link("#\(tag.name)", .tag(id: tag.id), count: tag.open, icon: "tag")
                }
            }
        }
        if !nav.views.isEmpty {
            Section("Views") {
                ForEach(nav.views) { view in
                    link(
                        view.name, .view(id: view.id), count: nil,
                        icon: view.layout == .board ? "rectangle.split.3x1" : "line.3.horizontal")
                }
            }
        }
    }

    private func link(_ title: String, _ scope: Scope, count: UInt32?, icon: String) -> some View {
        NavigationLink(value: Route.scope(scope, title: title)) {
            LabeledContent {
                if let count, count > 0 { Text("\(count)") }
            } label: {
                Label(title, systemImage: icon)
            }
        }
    }

    private func epicLink(_ epic: EpicItem) -> some View {
        link(
            epic.state == .active ? epic.name : "\(epic.name) (\(epic.state == .done ? "done" : "dropped"))",
            .epic(id: epic.id), count: epic.open, icon: "flag")
    }
}
