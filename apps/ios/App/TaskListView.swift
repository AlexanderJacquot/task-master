import SwiftUI
import TaskMasterKit

struct TaskListView: View {
    let list: TaskListModel
    let sync: SyncModel
    @State private var draft = ""
    @FocusState private var capturing: Bool

    var body: some View {
        List {
            ForEach(list.sections) { section in
                Section(section.label) {
                    ForEach(section.tasks) { task in
                        TaskRowView(task: task) {
                            withAnimation { list.toggle(task) }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button {
                                withAnimation { list.toggle(task) }
                            } label: {
                                Label(task.isClosed ? "Reopen" : "Done", systemImage: "checkmark")
                            }
                            .tint(.green)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if list.rows.isEmpty {
                ContentUnavailableView(
                    "Nothing here", systemImage: "tray",
                    description: Text("Add a task below."))
            }
        }
        .refreshable {
            await sync.syncNow()
        }
        .safeAreaInset(edge: .bottom) {
            capture
        }
    }

    private var capture: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let error = list.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("listError")
            }
            HStack {
                TextField("Add a task", text: $draft)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.done)
                    .focused($capturing)
                    .onSubmit(add)
                    .accessibilityIdentifier("captureField")
                Button("Add", systemImage: "plus.circle.fill", action: add)
                    .labelStyle(.iconOnly)
                    .font(.title2)
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("addButton")
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func add() {
        if list.add(draft) {
            draft = ""
        }
        // Stay ready for the next one.
        capturing = true
    }
}

struct TaskRowView: View {
    let task: TaskRow
    let toggle: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Button(action: toggle) {
                Image(systemName: task.isClosed ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(task.isClosed ? Color.green : tint)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(task.isClosed ? "Reopen" : "Mark done")

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .strikethrough(task.isClosed)
                    .foregroundStyle(task.isClosed ? .secondary : .primary)
                if !details.isEmpty {
                    Text(details)
                        .font(.footnote)
                        .foregroundStyle(task.overdue ? AnyShapeStyle(.red) : AnyShapeStyle(.secondary))
                }
            }
        }
        .padding(.leading, task.depth > 0 ? 28 : 0)
    }

    private var tint: Color {
        switch task.priority {
        case .urgent: .red
        case .high: .orange
        case .normal: .secondary
        case .low: .gray.opacity(0.6)
        }
    }

    /// Due date, project and subtask progress, on one line.
    private var details: String {
        var parts: [String] = []
        if let due = task.dueDate { parts.append(task.overdue ? "Overdue · \(due)" : "Due \(due)") }
        if let project = task.projectName { parts.append(project) }
        if task.childCount > 0 { parts.append("\(task.childDone)/\(task.childCount)") }
        return parts.joined(separator: " · ")
    }
}

extension TaskRow {
    var isClosed: Bool { stage == .done || stage == .cancelled }
}
