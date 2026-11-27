import SwiftUI
import TaskMasterKit

/// A task in a list: the check, the title, and one line of what matters about it (project
/// and epic, due date, estimate, tags, subtasks, assignee, a flag for high priority).
struct TaskRowView: View {
    let task: TaskRow
    let today: String
    /// Leave out the project (a project's own list).
    var showProject = true
    /// A line of its own instead of the usual details (the Inbox's "captured at").
    var caption: String?
    /// The status as a chip on the right (a project's list).
    var showStatus = false
    /// Nil: the check only shows the state (a row picked as a whole, the note's task picker).
    let toggle: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 4) {
            if let toggle {
                CheckButton(closed: task.isClosed, tint: Theme.check(task.priority), size: 24, action: toggle)
                    .accessibilityLabel(task.isClosed ? "Reopen \(task.title)" : "Complete \(task.title)")
            } else {
                CheckMark(closed: task.isClosed, tint: Theme.check(task.priority), size: 24)
                    .frame(width: 44, height: 44)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.body)
                    .strikethrough(task.isClosed)
                    .foregroundStyle(task.isClosed ? Theme.ink2 : Theme.ink)
                    .multilineTextAlignment(.leading)
                details
            }
            .padding(.vertical, 11)
            Spacer(minLength: 0)
            if showStatus && !task.statusName.isEmpty {
                StatusChip(name: task.statusName, stage: task.stage)
                    .padding(.top, 12)
            }
        }
        .padding(.leading, task.depth > 0 ? 28 : 0)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var details: some View {
        if let caption {
            Text(caption).font(.footnote).foregroundStyle(Theme.ink2)
        } else if !parts.isEmpty || flagged {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if showProject, task.projectName != nil {
                    Circle().fill(Theme.project(task.projectColor)).frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                }
                // One text, so the line wraps between items rather than inside them.
                Text(line).lineLimit(2)
            }
            .font(.footnote)
            .foregroundStyle(Theme.ink2)
        }
    }

    private var flagged: Bool { task.priority == .high || task.priority == .urgent }

    /// Project › epic, due date, estimate, tags, subtasks and assignee, in order.
    private var parts: [(String, Color?)] {
        var parts: [(String, Color?)] = []
        if showProject, let project = task.projectName {
            parts.append((task.epicName.map { "\(project) › \($0)" } ?? project, nil))
        } else if showProject, let epic = task.epicName {
            parts.append((epic, nil))
        }
        if let due = task.dueDate {
            let when = Dates.relative(due, today: today)
            parts.append((task.overdue ? "due \(when)" : when, task.overdue ? Theme.danger : nil))
        }
        if let minutes = task.estimateMin { parts.append((Dates.duration(minutes: minutes), nil)) }
        parts += task.tags.prefix(2).map { ("#\($0)", nil) }
        if task.childCount > 0 { parts.append(("\(task.childDone)/\(task.childCount)", nil)) }
        if let assignee = task.assignee { parts.append(("@\(assignee)", nil)) }
        return parts
    }

    private var line: AttributedString {
        var out = AttributedString()
        for (index, (text, color)) in parts.enumerated() {
            if index > 0 { out += AttributedString(" · ") }
            var piece = AttributedString(text)
            if let color {
                piece.foregroundColor = color
                piece.font = .footnote.weight(.medium)
            }
            out += piece
        }
        if flagged {
            var flag = AttributedString(parts.isEmpty ? "⚑" : "  ⚑")
            flag.foregroundColor = Theme.check(task.priority)
            out += flag
        }
        return out
    }
}

/// A status as a small tinted label: in progress in blue, to do and backlog plain.
struct StatusChip: View {
    let name: String
    let stage: Stage

    var body: some View {
        Text(name)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .foregroundStyle(ink)
            .background(ground, in: Capsule())
    }

    private var ink: Color {
        switch stage {
        case .inProgress: Theme.progressInk
        case .done: Theme.done
        default: Theme.ink2
        }
    }

    private var ground: Color {
        stage == .inProgress ? Theme.progressSoft : Theme.fill
    }
}

/// The round check: an open ring, or filled with a tick once done.
struct CheckButton: View {
    let closed: Bool
    var tint: Color = Theme.ink3
    var size: CGFloat = 24
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            CheckMark(closed: closed, tint: tint, size: size)
                .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.success, trigger: closed) { _, now in now }
    }
}

/// The check's look: an open ring, or filled with a tick.
struct CheckMark: View {
    let closed: Bool
    var tint: Color = Theme.ink3
    var size: CGFloat = 24

    var body: some View {
        ZStack {
            if closed {
                Circle().fill(Theme.done)
                Image(systemName: "checkmark")
                    .font(.system(size: size * 0.45, weight: .bold))
                    .foregroundStyle(.white)
            } else {
                Circle().strokeBorder(tint, lineWidth: 1.6)
            }
        }
        .frame(width: size, height: size)
    }
}

/// A task row in a `List`: opens the task, and the swipes and menu every list offers.
struct TaskListRow: View {
    let task: TaskRow
    let list: TaskListModel
    let today: String
    var showProject = true
    var caption: String?
    var showStatus = false
    /// Swiping left offers filing it in a project (the Inbox).
    var onFile: ((TaskRow) -> Void)?

    var body: some View {
        TaskRowView(
            task: task, today: today, showProject: showProject, caption: caption,
            showStatus: showStatus
        ) {
            withAnimation { list.toggle(task) }
        }
        // A link without the list's chevron: the row reads as a task, not a menu item.
        .background {
            NavigationLink(value: Route.task(id: task.id)) { EmptyView() }.opacity(0)
        }
        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
        .listRowBackground(Theme.ground)
        .listRowSeparatorTint(Theme.line)
        .alignmentGuide(.listRowSeparatorLeading) { _ in 52 }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                withAnimation { list.toggle(task) }
            } label: {
                Label(task.isClosed ? "Reopen" : "Done", systemImage: "checkmark")
            }
            .tint(Theme.done)
        }
        .swipeActions(edge: .trailing) {
            Button {
                withAnimation { list.setToday(task, !task.today) }
            } label: {
                Label(task.today ? "Not today" : "Today", systemImage: task.today ? "sun.min" : "sun.max")
            }
            .tint(Theme.accent)
            if let onFile {
                Button {
                    onFile(task)
                } label: {
                    Label("Project", systemImage: "folder")
                }
                .tint(Theme.high)
            }
        }
        .contextMenu {
            Button(task.isClosed ? "Reopen" : "Complete", systemImage: "checkmark.circle") {
                list.toggle(task)
            }
            Button(task.today ? "Take off today" : "Do today", systemImage: "sun.max") {
                list.setToday(task, !task.today)
            }
            if let onFile {
                Button("Move to a project", systemImage: "folder") { onFile(task) }
            }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) {
                withAnimation { list.delete(task) }
            }
        }
    }
}

extension TaskRow {
    var isClosed: Bool { stage == .done || stage == .cancelled }
}

/// Picks a project for a task (filing from the Inbox).
struct ProjectPicker: View {
    let projects: [ProjectItem]
    let pick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Button {
                    pick(nil)
                    dismiss()
                } label: {
                    Label("Inbox", systemImage: "tray").foregroundStyle(Theme.ink)
                }
                ForEach(projects) { project in
                    Button {
                        pick(project.id)
                        dismiss()
                    } label: {
                        HStack(spacing: 10) {
                            Circle().fill(Theme.project(project.color)).frame(width: 10, height: 10)
                            Text(project.name).foregroundStyle(Theme.ink)
                        }
                        .padding(.leading, CGFloat(project.depth) * 18)
                    }
                }
            }
            .navigationTitle("Move to")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
