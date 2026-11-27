import SwiftUI
import TaskMasterKit

/// The Inbox: captures waiting to be sorted, newest last as the core orders them. Swipe
/// right to complete; left to do it today or file it in a project.
struct InboxView: View {
    let session: Session
    let nav: NavigationModel
    @State private var list: TaskListModel
    @State private var filing: TaskRow?

    init(session: Session, nav: NavigationModel) {
        self.session = session
        self.nav = nav
        _list = State(initialValue: TaskListModel(session: session, scope: .inbox))
    }

    var body: some View {
        let tasks = list.tasks
        List {
            if !tasks.isEmpty {
                Section {
                    ForEach(tasks) { task in
                        TaskListRow(
                            task: task, list: list, today: session.day.today,
                            caption: caption(task), onFile: { filing = $0 })
                    }
                } header: {
                    Text("Swipe left to plan a task for today or give it a project; swipe right to complete it.")
                        .font(.footnote)
                        .foregroundStyle(Theme.ink2)
                        .textCase(nil)
                }
            }
            if let error = list.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .overlay {
            if tasks.isEmpty {
                ContentUnavailableView(
                    "Inbox zero", systemImage: "tray",
                    description: Text("Anything you capture without a project lands here."))
            }
        }
        .navigationTitle("Inbox")
        .navigationSubtitle(tasks.isEmpty ? "" : "\(tasks.count) to sort")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { UndoMenu(list: list) }
        }
        .sheet(item: $filing) { task in
            ProjectPicker(projects: nav.projects(team: task.team)) { project in
                withAnimation { list.setProject(task, project) }
            }
        }
    }

    /// "Captured 08:12", "Captured yesterday", "Captured Monday", else a date.
    private func caption(_ task: TaskRow) -> String {
        let made = Session.date(task.createdAt)
        let calendar = Calendar.current
        let when: String
        if calendar.isDateInToday(made) {
            when = made.formatted(date: .omitted, time: .shortened)
        } else if calendar.isDateInYesterday(made) {
            when = "yesterday"
        } else if let days = calendar.dateComponents([.day], from: made, to: Date()).day, days < 7 {
            when = made.formatted(.dateTime.weekday(.wide))
        } else {
            when = made.formatted(.dateTime.day().month(.abbreviated))
        }
        var parts = ["Captured \(when)"]
        if !task.tags.isEmpty { parts.append(task.tags.map { "#\($0)" }.joined(separator: " ")) }
        if let due = task.dueDate { parts.append("due \(Dates.relative(due, today: session.day.today))") }
        return parts.joined(separator: " · ")
    }
}
