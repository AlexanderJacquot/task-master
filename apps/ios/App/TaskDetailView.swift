import PhotosUI
import QuickLook
import SwiftUI
import TaskMasterKit

/// A task in full. The title and its place (project › epic) on top, every field as a chip
/// that opens its editor, then the notes, subtasks, planned time, attachments and history.
/// Each control calls one model edit (one undo step).
struct TaskDetailView: View {
    let session: Session
    @State private var model: TaskDetailModel
    @State private var nav: NavigationModel
    @State private var title = ""
    @State private var newSubtask = ""
    @State private var photo: PhotosPickerItem?
    @State private var importing = false
    @State private var preview: URL?
    @State private var editingNotes = false
    @State private var editingTags = false
    @State private var editingDue = false
    @State private var planning = false
    @State private var confirmingDelete = false
    @FocusState private var titleFocused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.push) private var push

    init(session: Session, id: String) {
        self.session = session
        _model = State(initialValue: TaskDetailModel(session: session, id: id))
        _nav = State(initialValue: NavigationModel(session: session))
    }

    var body: some View {
        Group {
            if let detail = model.detail {
                content(detail)
                    .sheet(isPresented: $editingNotes) {
                        NotesEditor(text: detail.description) { model.setDescription($0) }
                    }
                    .sheet(isPresented: $editingTags) {
                        TagsEditor(
                            tags: nav.tags(team: detail.row.team), chosen: Set(detail.tags.map(\.id)),
                            create: { nav.createTag($0, for: detail.row.id) },
                            save: { model.setTags($0) })
                    }
                    .sheet(isPresented: $editingDue) {
                        DueEditor(due: detail.row.dueDate.flatMap(Dates.parse)) { date in
                            model.setDueDate(date.map(Dates.iso))
                        }
                    }
                    .sheet(isPresented: $planning) {
                        PlanEditor(minutes: detail.estimateMin ?? 60) { start, end in
                            model.schedule(from: start, to: end)
                        }
                    }
                    .confirmationDialog(
                        "Delete this task?", isPresented: $confirmingDelete, titleVisibility: .visible
                    ) {
                        Button("Delete", role: .destructive) {
                            model.delete()
                            dismiss()
                        }
                    } message: {
                        Text("Undo brings it back.")
                    }
            } else {
                ContentUnavailableView("This task was deleted", systemImage: "trash")
            }
        }
        .background(Theme.ground)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.detail != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Plan time", systemImage: "calendar.badge.plus") { planning = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("More", systemImage: "ellipsis") {
                        NavigationLink(value: Route.activity(id: model.id)) {
                            Label("Activity", systemImage: "clock.arrow.circlepath")
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            confirmingDelete = true
                        }
                    }
                }
            }
        }
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

    private func content(_ detail: TaskDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header(detail)
                chips(detail)
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                notes(detail)
                    .padding(.horizontal, 20)
                    .padding(.top, 20)
                if let parent = detail.parent {
                    NavigationLink(value: Route.task(id: parent.id)) {
                        Label("Subtask of \(parent.title)", systemImage: "arrow.turn.left.up")
                            .font(.subheadline)
                            .foregroundStyle(Theme.accentText)
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                }
                subtasks(detail)
                if !detail.blockedBy.isEmpty {
                    group("Waits on") {
                        ForEach(detail.blockedBy) { other in
                            NavigationLink(value: Route.task(id: other.id)) {
                                Label(other.title, systemImage: "hourglass")
                                    .foregroundStyle(Theme.ink)
                                    .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                            }
                        }
                        .padding(.horizontal, 20)
                    }
                }
                planned(detail)
                taskNotes(detail)
                attachments(detail)
                if let error = model.error {
                    Text(error).font(.footnote).foregroundStyle(Theme.danger)
                        .padding(20)
                }
            }
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: Header

    private func header(_ detail: TaskDetail) -> some View {
        HStack(alignment: .top, spacing: 4) {
            CheckButton(
                closed: detail.row.isClosed, tint: Theme.check(detail.row.priority), size: 28
            ) { model.toggleDone() }
            .accessibilityLabel(detail.row.isClosed ? "Reopen" : "Complete")
            VStack(alignment: .leading, spacing: 6) {
                TextField("Title", text: $title, axis: .vertical)
                    .font(.title2.bold())
                    .foregroundStyle(Theme.ink)
                    .focused($titleFocused)
                    .submitLabel(.done)
                    .onSubmit { commitTitle(detail) }
                    .onChange(of: titleFocused) { _, focused in
                        if !focused { commitTitle(detail) }
                    }
                    .onAppear { title = detail.row.title }
                    .onChange(of: detail.row.title) { _, new in if !titleFocused { title = new } }
                place(detail)
            }
            .padding(.top, 6)
        }
        .padding(.leading, 10)
        .padding(.trailing, 20)
        .padding(.top, 8)
    }

    /// Project › epic, as a menu that moves the task.
    private func place(_ detail: TaskDetail) -> some View {
        Menu {
            Picker("Project", selection: Binding(
                get: { detail.projectId },
                set: { id in
                    let epics = nav.projects.first { $0.id == id }?.epics ?? nav.looseEpics
                    model.setProject(id, epics: epics)
                })
            ) {
                Label(detail.row.team ? "No project" : "Inbox", systemImage: "tray").tag(String?.none)
                ForEach(nav.projects(team: detail.row.team)) { project in
                    Text(String(repeating: "   ", count: Int(project.depth)) + project.name)
                        .tag(Optional(project.id))
                }
            }
            let epics = nav.epics(team: detail.row.team)
                .filter { $0.project?.id == detail.projectId || $0.project == nil }
            if !epics.isEmpty {
                Picker("Epic", selection: Binding(get: { detail.epicId }, set: { model.setEpic($0) })) {
                    Text("No epic").tag(String?.none)
                    ForEach(epics, id: \.epic.id) { pair in
                        Text(pair.epic.name).tag(Optional(pair.epic.id))
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(Theme.project(detail.row.projectColor)).frame(width: 8, height: 8)
                Text(placeName(detail))
                Image(systemName: "chevron.up.chevron.down").imageScale(.small)
            }
            .font(.subheadline)
            .foregroundStyle(Theme.ink2)
        }
        .accessibilityLabel("Project: \(placeName(detail))")
    }

    private func placeName(_ detail: TaskDetail) -> String {
        guard let project = detail.row.projectName else { return detail.row.team ? "No project" : "Inbox" }
        return detail.epicName.map { "\(project) › \($0)" } ?? project
    }

    // MARK: Fields

    private func chips(_ detail: TaskDetail) -> some View {
        FlowLayout(spacing: 8) {
            Menu {
                Picker("Status", selection: Binding(get: { detail.statusId }, set: { model.setStatus($0) })) {
                    ForEach(nav.statuses(team: detail.row.team)) { Text($0.name).tag($0.id) }
                }
            } label: {
                Chip(
                    label: detail.row.statusName, systemImage: stageIcon(detail.row.stage),
                    ink: detail.row.stage == .inProgress ? Theme.progressInk : Theme.ink,
                    ground: detail.row.stage == .inProgress ? Theme.progressSoft : Theme.fill, bold: true)
            }
            .accessibilityLabel("Status: \(detail.row.statusName)")

            Button {
                model.setToday(!detail.row.today)
            } label: {
                Chip(
                    label: "Today", systemImage: "sun.max",
                    ink: detail.row.today ? Theme.accentText : Theme.ink,
                    ground: detail.row.today ? Theme.accentSoft : Theme.fill, bold: detail.row.today)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(detail.row.today ? .isSelected : [])

            Button {
                editingDue = true
            } label: {
                Chip(
                    label: detail.row.dueDate.map { "Due \(Dates.relative($0, today: session.day.today))" } ?? "Due date",
                    systemImage: "calendar",
                    ink: detail.row.overdue ? Theme.danger : (detail.row.dueDate == nil ? Theme.ink2 : Theme.ink))
            }
            .buttonStyle(.plain)

            Menu {
                Picker("Priority", selection: Binding(
                    get: { detail.row.priority }, set: { model.setPriority($0) })
                ) {
                    Label("Urgent", systemImage: "exclamationmark.2").tag(Priority.urgent)
                    Label("High", systemImage: "flag.fill").tag(Priority.high)
                    Label("Normal", systemImage: "flag").tag(Priority.normal)
                    Label("Low", systemImage: "arrow.down").tag(Priority.low)
                }
            } label: {
                priorityChip(detail.row.priority)
            }

            Menu {
                ForEach([15, 30, 45, 60, 90, 120, 180, 240] as [Int64], id: \.self) { minutes in
                    Button(Dates.duration(minutes: minutes)) { model.setEstimate(minutes) }
                }
                if detail.estimateMin != nil {
                    Divider()
                    Button("No estimate", role: .destructive) { model.setEstimate(nil) }
                }
            } label: {
                Chip(
                    label: detail.estimateMin.map { Dates.duration(minutes: $0) } ?? "Estimate",
                    systemImage: "clock", ink: detail.estimateMin == nil ? Theme.ink2 : Theme.ink)
            }

            if detail.row.team, let team = nav.team {
                Menu {
                    Picker("Assignee", selection: Binding(
                        get: { detail.assigneeId }, set: { model.setAssignee($0) })
                    ) {
                        Text("Nobody").tag(String?.none)
                        ForEach(team.members, id: \.id) { member in
                            Text(member.me ? "\(member.name) (you)" : member.name).tag(Optional(member.id))
                        }
                    }
                } label: {
                    Chip(label: detail.row.assignee.map { "@\($0)" } ?? "Assignee", systemImage: "person")
                }
            }

            ForEach(detail.tags) { tag in
                Button {
                    editingTags = true
                } label: {
                    Chip(label: "#\(tag.name)")
                }
                .buttonStyle(.plain)
            }
            Button {
                editingTags = true
            } label: {
                Image(systemName: detail.tags.isEmpty ? "number" : "plus")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.ink2)
                    .frame(width: 32, height: 32)
                    .overlay(Capsule().strokeBorder(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [3])))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Tags")
        }
    }

    private func priorityChip(_ priority: Priority) -> Chip {
        switch priority {
        case .urgent: Chip(label: "Urgent", systemImage: "exclamationmark.2", ink: Theme.danger, ground: Theme.highSoft, bold: true)
        case .high: Chip(label: "High", systemImage: "flag.fill", ink: Theme.highInk, ground: Theme.highSoft, bold: true)
        case .normal: Chip(label: "Priority", systemImage: "flag", ink: Theme.ink2)
        case .low: Chip(label: "Low", systemImage: "arrow.down")
        }
    }

    private func stageIcon(_ stage: Stage) -> String {
        switch stage {
        case .backlog: "circle.dotted"
        case .todo: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .done: "checkmark.circle.fill"
        case .cancelled: "xmark.circle"
        }
    }

    // MARK: Notes

    @ViewBuilder
    private func notes(_ detail: TaskDetail) -> some View {
        if detail.description.isEmpty {
            Button {
                editingNotes = true
            } label: {
                Label("Add a description", systemImage: "text.alignleft")
                    .font(.callout)
                    .foregroundStyle(Theme.ink2)
            }
            .buttonStyle(.plain)
        } else {
            Button {
                editingNotes = true
            } label: {
                MarkdownText(source: detail.description)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Edit the description")
        }
    }

    // MARK: Notes

    /// Its notes (ADR 032): attached ones, then those linking to it; New note writes one
    /// attached to it, titled like it.
    private func taskNotes(_ detail: TaskDetail) -> some View {
        group("Notes", detail: model.notes.isEmpty ? nil : "\(model.notes.count)") {
            VStack(spacing: 0) {
                ForEach(model.notes) { note in
                    NavigationLink(value: Route.note(id: note.id)) {
                        HStack {
                            NoteRow(note: note, today: session.day.today)
                            Spacer()
                            Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Theme.ink3)
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
                Button {
                    if let id = model.newNote() { push(.note(id: id, isNew: true)) }
                } label: {
                    Label("New note", systemImage: "square.and.pencil")
                        .foregroundStyle(Theme.accentText)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .accessibilityIdentifier("taskNewNote")
            }
            .padding(.horizontal, 20)
        }
    }

    // MARK: Subtasks

    private func subtasks(_ detail: TaskDetail) -> some View {
        group(
            "Subtasks",
            detail: detail.subtasks.isEmpty ? nil : "\(detail.row.childDone) of \(detail.row.childCount)"
        ) {
            ForEach(detail.subtasks) { sub in
                HStack(spacing: 2) {
                    CheckButton(closed: sub.isClosed, size: 20) { model.toggle(sub) }
                        .accessibilityLabel(sub.isClosed ? "Reopen \(sub.title)" : "Complete \(sub.title)")
                    NavigationLink(value: Route.task(id: sub.id)) {
                        Text(sub.title)
                            .strikethrough(sub.isClosed)
                            .foregroundStyle(sub.isClosed ? Theme.ink2 : Theme.ink)
                            .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
                    }
                    .contextMenu {
                        Button("Make it a task of its own", systemImage: "arrow.up.left") { model.detach(sub) }
                    }
                }
                .padding(.leading, 10)
                .padding(.trailing, 20)
            }
            HStack(spacing: 10) {
                Image(systemName: "plus").foregroundStyle(Theme.accentText).frame(width: 20)
                TextField("Add subtask", text: $newSubtask)
                    .submitLabel(.done)
                    .onSubmit {
                        if model.addSubtask(newSubtask) { newSubtask = "" }
                    }
            }
            .frame(minHeight: 40)
            .padding(.leading, 22)
            .padding(.trailing, 20)
        }
    }

    // MARK: Time

    @ViewBuilder
    private func planned(_ detail: TaskDetail) -> some View {
        group("Planned") {
            ForEach(detail.blocks) { block in
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 4, height: 24)
                    Text(blockTime(block)).foregroundStyle(Theme.ink)
                    Spacer()
                    if block.outcome != .planned {
                        Text(outcomeName(block.outcome)).font(.footnote).foregroundStyle(Theme.ink2)
                    }
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(Theme.fill, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16)
                .padding(.bottom, 6)
            }
            Button {
                planning = true
            } label: {
                Label("Plan time", systemImage: "calendar.badge.plus")
                    .foregroundStyle(Theme.accentText)
                    .frame(minHeight: 40)
            }
            .padding(.horizontal, 20)
        }
    }

    private func blockTime(_ block: BlockItem) -> String {
        let start = Session.date(block.startAt)
        let day = Calendar.current.isDateInToday(start)
            ? "Today" : start.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
        return "\(day), \(clockTime(block.startAt)) – \(clockTime(block.endAt))"
    }

    private func outcomeName(_ outcome: Outcome) -> String {
        switch outcome {
        case .planned: "Planned"
        case .done: "Done"
        case .worked: "Worked on it"
        case .missed: "Missed"
        case .cancelled: "Cancelled"
        }
    }

    // MARK: Attachments

    private func attachments(_ detail: TaskDetail) -> some View {
        group("Attachments") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(detail.attachments) { item in
                        Button {
                            Task { preview = await model.open(item) }
                        } label: {
                            VStack(spacing: 6) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: 12).fill(Theme.fill)
                                    if model.fetching == item.id {
                                        ProgressView()
                                    } else {
                                        Image(systemName: item.onDevice ? "doc" : "icloud.and.arrow.down")
                                            .font(.title2)
                                            .foregroundStyle(Theme.ink2)
                                    }
                                }
                                .frame(width: 84, height: 84)
                                Text(item.name).font(.caption).foregroundStyle(Theme.ink2).lineLimit(1)
                                    .frame(width: 84)
                            }
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Remove", systemImage: "trash", role: .destructive) { model.remove(item) }
                        }
                    }
                    Menu {
                        PhotosPicker(selection: $photo, matching: .images) {
                            Label("Photo", systemImage: "photo")
                        }
                        Button("File", systemImage: "doc") { importing = true }
                    } label: {
                        VStack(spacing: 6) {
                            RoundedRectangle(cornerRadius: 12)
                                .strokeBorder(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [4]))
                                .frame(width: 84, height: 84)
                                .overlay(Image(systemName: "plus").font(.title3).foregroundStyle(Theme.ink2))
                            Text("Add").font(.caption).foregroundStyle(Theme.ink2)
                        }
                    }
                    .accessibilityLabel("Add an attachment")
                }
                .padding(.horizontal, 20)
            }
        }
    }

    // MARK: Helpers

    private func group<Content: View>(
        _ title: String, detail: String? = nil, @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title.uppercased())
                    .font(.footnote.weight(.semibold))
                    .tracking(0.4)
                    .foregroundStyle(Theme.ink2)
                Spacer()
                if let detail { Text(detail).font(.footnote).foregroundStyle(Theme.ink2) }
            }
            .padding(.horizontal, 20)
            .accessibilityAddTraits(.isHeader)
            content()
        }
        .padding(.top, 24)
    }

    private func commitTitle(_ detail: TaskDetail) {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            title = detail.row.title
        } else if trimmed != detail.row.title {
            model.setTitle(trimmed)
        }
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
}

/// Markdown notes, drawn: paragraphs, bullet and numbered lines, headings, inline styles.
struct MarkdownText: View {
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                line
            }
        }
        .font(.body)
        .foregroundStyle(Theme.ink)
    }

    private var lines: [AnyView] {
        source.split(separator: "\n", omittingEmptySubsequences: true).map { raw in
            let line = String(raw)
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") {
                let text = trimmed.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)
                return AnyView(inline(text).font(.headline))
            }
            for bullet in ["- [ ] ", "- [x] ", "- ", "* "] where trimmed.hasPrefix(bullet) {
                let mark = bullet.contains("[x]") ? "☑︎" : bullet.contains("[ ]") ? "☐" : "•"
                return AnyView(
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(mark).foregroundStyle(Theme.ink2)
                        inline(String(trimmed.dropFirst(bullet.count)))
                    }
                    .padding(.leading, 4))
            }
            return AnyView(inline(line))
        }
    }

    private func inline(_ text: String) -> Text {
        if let styled = try? AttributedString(
            markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        {
            return Text(styled)
        }
        return Text(text)
    }
}

/// The description in a sheet, as markdown source.
struct NotesEditor: View {
    @State var text: String
    let save: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding(.horizontal, 12)
                .navigationTitle("Description")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            save(text)
                            dismiss()
                        }
                    }
                }
        }
    }
}

/// Picks a task's tags, and makes new ones.
struct TagsEditor: View {
    let tags: [TagItem]
    @State var chosen: Set<String>
    let create: (String) -> String?
    let save: ([String]) -> Void
    @State private var newTag = ""
    @State private var made: [TagItem] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("New tag", text: $newTag)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit(add)
                        Button("Add", action: add)
                            .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section {
                    ForEach(tags + made.filter { m in !tags.contains { $0.id == m.id } }) { tag in
                        Button {
                            if chosen.contains(tag.id) { chosen.remove(tag.id) } else { chosen.insert(tag.id) }
                        } label: {
                            HStack {
                                Text("#\(tag.name)").foregroundStyle(Theme.ink)
                                Spacer()
                                if chosen.contains(tag.id) {
                                    Image(systemName: "checkmark").foregroundStyle(Theme.accentText)
                                }
                            }
                        }
                        .accessibilityAddTraits(chosen.contains(tag.id) ? .isSelected : [])
                    }
                }
            }
            .navigationTitle("Tags")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        save(Array(chosen))
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func add() {
        let name = newTag.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, let id = create(name) else { return }
        chosen.insert(id)
        made.append(TagItem(id: id, name: name.hasPrefix("#") ? String(name.dropFirst()) : name, color: nil, open: 0, team: false))
        newTag = ""
    }
}

/// A due date: a calendar, quick picks, or none.
struct DueEditor: View {
    @State var due: Date?
    let save: (Date?) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    quick("Today", days: 0)
                    quick("Tomorrow", days: 1)
                    quick("Next week", days: 7)
                }
                DatePicker(
                    "Due", selection: Binding(get: { due ?? Date() }, set: { due = $0 }),
                    displayedComponents: .date)
                    .datePickerStyle(.graphical)
                    .tint(Theme.accent)
                Spacer()
            }
            .padding(.horizontal, 16)
            .navigationTitle("Due date")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        save(due)
                        dismiss()
                    }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button("No due date", role: .destructive) {
                        save(nil)
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.large])
    }

    private func quick(_ label: String, days: Int) -> some View {
        Button {
            due = Calendar.current.date(byAdding: .day, value: days, to: Calendar.current.startOfDay(for: Date()))
        } label: {
            Chip(label: label)
        }
        .buttonStyle(.plain)
    }
}

/// Plans a time block for the task: a start and a length.
struct PlanEditor: View {
    @State var minutes: Int64
    let save: (Date, Date) -> Void
    @State private var start = PlanEditor.nextQuarter()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                DatePicker("Starts", selection: $start, displayedComponents: [.date, .hourAndMinute])
                Picker("Length", selection: $minutes) {
                    ForEach([15, 30, 45, 60, 90, 120, 180, 240] as [Int64], id: \.self) {
                        Text(Dates.duration(minutes: $0)).tag($0)
                    }
                    if ![15, 30, 45, 60, 90, 120, 180, 240].contains(minutes) {
                        Text(Dates.duration(minutes: minutes)).tag(minutes)
                    }
                }
            }
            .navigationTitle("Plan time")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Plan") {
                        save(start, start.addingTimeInterval(Double(minutes * 60)))
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }

    static func nextQuarter() -> Date {
        let quarter = 15 * 60.0
        return Date(timeIntervalSince1970: (Date().timeIntervalSince1970 / quarter).rounded(.up) * quarter)
    }
}

/// What happened to a task, newest first.
struct ActivityView: View {
    @State private var model: TaskDetailModel

    init(session: Session, id: String) {
        _model = State(initialValue: TaskDetailModel(session: session, id: id))
    }

    var body: some View {
        List {
            ForEach(Array(model.activity.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.kind).font(.subheadline.weight(.semibold))
                    ForEach(item.fields, id: \.field) { field in
                        Text("\(field.field): \(field.before) → \(field.after)")
                            .font(.footnote).foregroundStyle(Theme.ink2).lineLimit(2)
                    }
                    Text(Session.date(item.at), style: .relative).font(.caption).foregroundStyle(Theme.ink2)
                }
                .padding(.vertical, 4)
            }
        }
        .overlay {
            if model.activity.isEmpty { ContentUnavailableView("No history yet", systemImage: "clock") }
        }
        .navigationTitle("Activity")
    }
}
