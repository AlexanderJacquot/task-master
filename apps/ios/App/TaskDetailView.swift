import PhotosUI
import QuickLook
import SwiftUI
import TaskMasterKit

/// A task in full, every field editable. A stand-in screen: each control calls one model
/// edit, so the design pass can replace the layout without touching behaviour.
struct TaskDetailView: View {
    let session: Session
    @State private var model: TaskDetailModel
    @State private var nav: NavigationModel
    @State private var title = ""
    @State private var description = ""
    @State private var newSubtask = ""
    @State private var newTag = ""
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var preview: URL?
    @Environment(\.dismiss) private var dismiss

    init(session: Session, id: String) {
        self.session = session
        _model = State(initialValue: TaskDetailModel(session: session, id: id))
        _nav = State(initialValue: NavigationModel(session: session))
    }

    var body: some View {
        Group {
            if let detail = model.detail {
                form(detail)
            } else {
                ContentUnavailableView("This task was deleted", systemImage: "trash")
            }
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .quickLookPreview($preview)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item]) { result in
            if case .success(let url) = result {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                model.attach(url)
            }
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await attach(item) }
        }
    }

    private func form(_ detail: TaskDetail) -> some View {
        Form {
            Section {
                TextField("Title", text: $title, axis: .vertical)
                    .font(.headline)
                    .onSubmit { model.setTitle(title) }
                    .onAppear { title = detail.row.title }
                    .onChange(of: detail.row.title) { _, new in title = new }
                Toggle(detail.row.stage.isClosed ? "Done" : "Open", isOn: Binding(
                    get: { detail.row.stage.isClosed },
                    set: { _ in model.toggleDone() }))
                if let parent = detail.parent {
                    NavigationLink(value: Route.task(id: parent.id)) {
                        LabeledContent("Subtask of", value: parent.title)
                    }
                }
            }

            Section("Plan") {
                Picker("Status", selection: Binding(
                    get: { detail.statusId },
                    set: { model.setStatus($0) })) {
                    ForEach(nav.statuses) { Text($0.name).tag($0.id) }
                }
                Picker("Priority", selection: Binding(
                    get: { detail.row.priority },
                    set: { model.setPriority($0) })) {
                    Text("Urgent").tag(Priority.urgent)
                    Text("High").tag(Priority.high)
                    Text("Normal").tag(Priority.normal)
                    Text("Low").tag(Priority.low)
                }
                Toggle("Today", isOn: Binding(get: { detail.row.today }, set: { model.setToday($0) }))
                dueDate(detail)
                Stepper(
                    detail.estimateMin.map { "Estimate: \($0) min" } ?? "No estimate",
                    onIncrement: { model.setEstimate((detail.estimateMin ?? 0) + 15) },
                    onDecrement: {
                        let next = (detail.estimateMin ?? 0) - 15
                        model.setEstimate(next > 0 ? next : nil)
                    })
            }

            Section("Where") {
                Picker("Project", selection: Binding(
                    get: { detail.projectId },
                    set: { id in
                        let epics = nav.projects.first { $0.id == id }?.epics ?? nav.looseEpics
                        model.setProject(id, epics: epics)
                    })) {
                    Text("None (Inbox)").tag(String?.none)
                    ForEach(nav.projects) { project in
                        Text(String(repeating: "  ", count: Int(project.depth)) + project.name)
                            .tag(Optional(project.id))
                    }
                }
                Picker("Epic", selection: Binding(
                    get: { detail.epicId },
                    set: { model.setEpic($0) })) {
                    Text("None").tag(String?.none)
                    ForEach(nav.epics, id: \.epic.id) { pair in
                        Text(pair.project.map { "\($0.name) › \(pair.epic.name)" } ?? pair.epic.name)
                            .tag(Optional(pair.epic.id))
                    }
                }
            }

            tags(detail)

            Section("Notes") {
                TextField("Markdown", text: $description, axis: .vertical)
                    .lineLimit(4...)
                    .onAppear { description = detail.description }
                if description != detail.description {
                    Button("Save notes") { model.setDescription(description) }
                }
                if !detail.description.isEmpty,
                    let rendered = try? AttributedString(
                        markdown: detail.description,
                        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
                {
                    Text(rendered).foregroundStyle(.secondary)
                }
            }

            subtasks(detail)
            attachments(detail)
            time(detail)

            if !detail.blockedBy.isEmpty {
                Section("Waits on") {
                    ForEach(detail.blockedBy) { other in
                        NavigationLink(other.title, value: Route.task(id: other.id))
                    }
                }
            }

            Section("Activity") {
                ForEach(Array(model.activity.enumerated()), id: \.offset) { _, item in
                    VStack(alignment: .leading) {
                        Text(item.kind).font(.subheadline)
                        ForEach(item.fields, id: \.field) { field in
                            Text("\(field.field): \(field.before) → \(field.after)")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Text(Session.date(item.at), style: .relative).font(.caption2)
                    }
                }
            }

            Section {
                Button("Delete task", role: .destructive) {
                    model.delete()
                    dismiss()
                }
            }

            if let error = model.error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
    }

    @ViewBuilder
    private func dueDate(_ detail: TaskDetail) -> some View {
        Toggle("Due date", isOn: Binding(
            get: { detail.row.dueDate != nil },
            set: { $0 ? model.setDueDate(session.day.today) : model.setDueDate(nil) }))
        if let due = detail.row.dueDate, let date = isoDate(due) {
            DatePicker(
                "Due", selection: Binding(get: { date }, set: { model.setDueDate(isoString($0)) }),
                displayedComponents: .date)
        }
    }

    private func tags(_ detail: TaskDetail) -> some View {
        Section("Tags") {
            ForEach(nav.tags) { tag in
                let on = detail.tags.contains { $0.id == tag.id }
                Button {
                    var ids = detail.tags.map(\.id)
                    if on { ids.removeAll { $0 == tag.id } } else { ids.append(tag.id) }
                    model.setTags(ids)
                } label: {
                    Label("#\(tag.name)", systemImage: on ? "checkmark.circle.fill" : "circle")
                }
            }
            HStack {
                TextField("New tag", text: $newTag)
                    .textInputAutocapitalization(.never)
                Button("Add") {
                    if let id = nav.createTag(newTag) {
                        model.setTags(detail.tags.map(\.id) + [id])
                        newTag = ""
                    }
                }
                .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func subtasks(_ detail: TaskDetail) -> some View {
        Section("Subtasks \(detail.row.childDone)/\(detail.row.childCount)") {
            ForEach(detail.subtasks) { sub in
                NavigationLink(value: Route.task(id: sub.id)) {
                    TaskRowView(task: sub) { model.toggle(sub) }
                }
                .swipeActions {
                    Button("Detach") { model.detach(sub) }
                }
            }
            .onMove { from, to in
                if let index = from.first { model.moveSubtask(detail.subtasks[index], to: to) }
            }
            HStack {
                TextField("Add a subtask", text: $newSubtask)
                    .onSubmit(addSubtask)
                Button("Add", action: addSubtask)
                    .disabled(newSubtask.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func attachments(_ detail: TaskDetail) -> some View {
        Section("Attachments") {
            ForEach(detail.attachments) { item in
                Button {
                    Task { preview = await model.open(item) }
                } label: {
                    LabeledContent(item.name) {
                        if model.fetching == item.id {
                            ProgressView()
                        } else {
                            Image(systemName: item.onDevice ? "doc" : "icloud.and.arrow.down")
                        }
                    }
                }
                .swipeActions {
                    Button("Remove", role: .destructive) { model.remove(item) }
                }
            }
            PhotosPicker(selection: $photo, matching: .images) {
                Label("Add a photo", systemImage: "photo")
            }
            Button {
                importing = true
            } label: {
                Label("Add a file", systemImage: "paperclip")
            }
        }
    }

    private func time(_ detail: TaskDetail) -> some View {
        Section("Time") {
            ForEach(detail.blocks) { block in
                LabeledContent(
                    "\(Session.date(block.startAt).formatted(date: .abbreviated, time: .shortened)) – \(clockTime(block.endAt))",
                    value: "\(block.outcome)")
            }
            Button("Plan the next hour") {
                // From the next quarter hour.
                let now = Date()
                let quarter = 15 * 60.0
                let start = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / quarter).rounded(.up) * quarter)
                model.schedule(from: start, to: start.addingTimeInterval(3600))
            }
        }
    }

    private func addSubtask() {
        if model.addSubtask(newSubtask) { newSubtask = "" }
    }

    /// Writes the picked photo to a temporary file and attaches it (the core copies it).
    private func attach(_ item: PhotosPickerItem) async {
        defer { photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("Photo \(Date().formatted(.iso8601)).\(ext)")
        do {
            try data.write(to: file)
            model.attach(file)
            try? FileManager.default.removeItem(at: file)
        } catch {}
    }

    private func isoDate(_ text: String) -> Date? {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: text)
    }

    private func isoString(_ date: Date) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }
}
