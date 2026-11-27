import PhotosUI
import QuickLook
import SwiftUI
import TaskMasterKit

/// The notes (ADR 032), folder by folder, or one folder's. Search reads titles and text.
struct NotesView: View {
    let session: Session
    let folderId: String?
    let title: String
    @State private var model: NotesModel
    @State private var naming: NoteFolderItem?
    @State private var newFolder = false
    @State private var folderName = ""
    @State private var confirmingDelete: NoteFolderItem?
    @Environment(\.push) private var push
    @Environment(\.dismiss) private var dismiss

    init(session: Session, folderId: String?, title: String) {
        self.session = session
        self.folderId = folderId
        self.title = title
        _model = State(initialValue: NotesModel(session: session))
    }

    var body: some View {
        List {
            if model.query.trimmingCharacters(in: .whitespaces).isEmpty {
                ForEach(model.groups(in: folderId)) { group in
                    Section {
                        ForEach(group.notes) { note in row(note) }
                        if group.notes.isEmpty {
                            Text("No notes in \(group.name) yet").foregroundStyle(Theme.ink3)
                                .listRowBackground(Color.clear)
                        }
                    } header: {
                        if folderId == nil { header(group) }
                    }
                }
            } else {
                ForEach(model.found) { note in row(note) }
            }
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.ground)
        .overlay {
            if model.notes.isEmpty && model.folders.isEmpty {
                ContentUnavailableView(
                    "No notes yet", systemImage: "note.text",
                    description: Text("Write one here or on the desktop: it syncs both ways."))
            } else if !model.query.isEmpty && model.found.isEmpty {
                ContentUnavailableView.search(text: model.query)
            }
        }
        .searchable(text: $model.query, prompt: "Search notes")
        .navigationTitle(title)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let folder = model.folders.first(where: { $0.id == folderId }) {
                    folderMenu(folder)
                } else if folderId == nil {
                    Button("New folder", systemImage: "folder.badge.plus") {
                        folderName = ""
                        newFolder = true
                    }
                }
                Button("New note", systemImage: "square.and.pencil") {
                    if let id = model.create(folderId: folderId) { push(.note(id: id, isNew: true)) }
                }
                .accessibilityIdentifier("newNote")
            }
        }
        .alert("New folder", isPresented: $newFolder) {
            TextField("Name", text: $folderName)
            Button("Cancel", role: .cancel) {}
            Button("Add") { model.createFolder(folderName) }
        }
        .alert(
            "Rename folder",
            isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })
        ) {
            TextField("Name", text: $folderName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { if let naming { model.renameFolder(naming, to: folderName) } }
        }
        .confirmationDialog(
            "Delete this folder?",
            isPresented: Binding(
                get: { confirmingDelete != nil }, set: { if !$0 { confirmingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete the folder", role: .destructive) {
                if let folder = confirmingDelete {
                    model.deleteFolder(folder)
                    if folder.id == folderId { dismiss() }
                }
            }
        } message: {
            Text("Its notes stay, outside any folder.")
        }
    }

    private func header(_ group: NotesModel.Group) -> some View {
        HStack(spacing: 8) {
            Image(systemName: group.folder == nil ? "tray" : "folder")
            Text(group.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            Spacer()
            if let folder = group.folder { folderMenu(folder) }
        }
        .foregroundStyle(Theme.ink2)
    }

    private func folderMenu(_ folder: NoteFolderItem) -> some View {
        Menu {
            Button("New note here", systemImage: "square.and.pencil") {
                if let id = model.create(folderId: folder.id) { push(.note(id: id, isNew: true)) }
            }
            Button("Rename", systemImage: "pencil") {
                folderName = folder.name
                naming = folder
            }
            Button("Delete folder", systemImage: "trash", role: .destructive) {
                confirmingDelete = folder
            }
        } label: {
            Image(systemName: "ellipsis").frame(width: 32, height: 32)
        }
        .accessibilityLabel("\(folder.name) actions")
    }

    private func row(_ note: NoteItem) -> some View {
        NavigationLink(value: Route.note(id: note.id)) {
            NoteRow(note: note, today: session.day.today)
        }
        .listRowBackground(Color.clear)
        .swipeActions {
            Button("Delete", systemImage: "trash", role: .destructive) { model.delete(note) }
        }
        .contextMenu {
            Menu("Move to", systemImage: "folder") {
                Button("No folder") { model.move(note, to: nil) }
                ForEach(model.folders) { folder in
                    Button(folder.name) { model.move(note, to: folder.id) }
                }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { model.delete(note) }
        }
    }
}

/// A note in a list: title, the start of its text, when it changed and its task.
struct NoteRow: View {
    let note: NoteItem
    let today: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(note.shownTitle)
                .font(.body.weight(.medium))
                .foregroundStyle(note.title.isEmpty ? Theme.ink3 : Theme.ink)
                .lineLimit(2)
            if !note.snippet.isEmpty {
                Text(note.snippet).font(.subheadline).foregroundStyle(Theme.ink2).lineLimit(1)
            }
            HStack(spacing: 6) {
                Text(edited(note.updatedAt, today: today))
                if let task = note.task {
                    Text("·")
                    Image(systemName: task.stage.isClosed ? "checkmark.circle" : "circle")
                    Text(task.title).lineLimit(1)
                }
            }
            .font(.footnote)
            .foregroundStyle(Theme.ink3)
        }
        .padding(.vertical, 2)
    }
}

/// "Today 21:40", "Yesterday", "Sun 22 Nov".
func edited(_ ms: Int64, today: String) -> String {
    let date = Session.date(ms)
    let day = Dates.iso(date)
    if day == today { return "Today \(clockTime(ms))" }
    let words = Dates.relative(day, today: today)
    return words.prefix(1).uppercased() + words.dropFirst()
}

/// One note. It opens rendered: checklists tick, task and project links open; Edit (or a
/// new note) shows the markdown with a bar of marks above the keyboard, and `[[` looks up
/// a task to link. What is typed saves after a short pause.
struct NoteView: View {
    let session: Session
    let isNew: Bool
    @State private var model: NoteModel
    @State private var notes: NotesModel
    @State private var editing: Bool
    @State private var selection: TextSelection?
    @State private var photo: PhotosPickerItem?
    @State private var preview: URL?
    @State private var choosingTask = false
    @State private var confirmingDelete = false
    @FocusState private var focus: Field?
    @Environment(\.push) private var push
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    private enum Field { case title, body }

    init(session: Session, id: String, isNew: Bool) {
        self.session = session
        self.isNew = isNew
        _model = State(initialValue: NoteModel(session: session, id: id))
        _notes = State(initialValue: NotesModel(session: session))
        _editing = State(initialValue: isNew)
    }

    var body: some View {
        Group {
            if let detail = model.detail {
                if editing { editor(detail) } else { reader(detail) }
            } else {
                ContentUnavailableView("This note was deleted", systemImage: "note.text")
            }
        }
        .background(Theme.ground)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .quickLookPreview($preview)
        .sheet(isPresented: $choosingTask) {
            TaskPicker(session: session) { model.attach(to: $0) }
        }
        .confirmationDialog("Delete this note?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                model.delete()
                dismiss()
            }
        }
        .onChange(of: photo) { _, item in
            if let item { Task { await attach(item) } }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { model.save() }
        }
        .onAppear { if isNew { focus = model.title.isEmpty ? .title : .body } }
        .onDisappear {
            if isNew && model.isUntouched { model.delete() } else { model.save() }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if editing {
                Button("Done") {
                    model.save()
                    focus = nil
                    editing = false
                }
                .fontWeight(.semibold)
                .accessibilityIdentifier("noteDone")
            } else if model.detail != nil {
                Button("Edit") {
                    editing = true
                    focus = .body
                }
                .accessibilityIdentifier("noteEdit")
                Menu {
                    Button(
                        model.detail?.task == nil ? "Attach to a task" : "Attach to another task",
                        systemImage: "link"
                    ) { choosingTask = true }
                    if model.detail?.task != nil {
                        Button("Detach from the task", systemImage: "xmark.circle") {
                            model.attach(to: nil)
                        }
                    }
                    if let detail = model.detail {
                        ShareLink(item: share(detail)) { Label("Share", systemImage: "square.and.arrow.up") }
                    }
                    Button("Delete", systemImage: "trash", role: .destructive) { confirmingDelete = true }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("Note actions")
            }
        }
    }

    // MARK: Reading

    private func reader(_ detail: NoteDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(detail.title.isEmpty ? "Untitled" : detail.title)
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(detail.title.isEmpty ? Theme.ink3 : Theme.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
                chips(detail)
                if detail.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button {
                        editing = true
                        focus = .body
                    } label: {
                        Text("Tap to write").foregroundStyle(Theme.ink3)
                            .frame(maxWidth: .infinity, minHeight: 120, alignment: .topLeading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    NoteMarkdown(
                        source: detail.body, links: detail.links, attachments: detail.attachments,
                        fetching: model.fetching,
                        toggle: { model.toggleCheck(line: $0) },
                        open: { item in Task { preview = await model.open(item) } })
                }
                footer(detail)
                if let error = model.error {
                    Text(error).font(.footnote).foregroundStyle(Theme.danger)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
        .environment(\.openURL, OpenURLAction { url in open(url, detail) })
    }

    private func chips(_ detail: NoteDetail) -> some View {
        HStack(spacing: 6) {
            Menu {
                Picker(
                    "Folder",
                    selection: Binding(get: { detail.folderId }, set: { model.move(to: $0) })
                ) {
                    Label("No folder", systemImage: "tray").tag(String?.none)
                    ForEach(notes.folders) { folder in
                        Label(folder.name, systemImage: "folder").tag(Optional(folder.id))
                    }
                }
            } label: {
                chip(detail.folderName ?? "No folder", icon: "folder")
            }
            .accessibilityLabel("Folder: \(detail.folderName ?? "none")")
            if let task = detail.task {
                Button { push(.task(id: task.id)) } label: {
                    chip(task.title, icon: task.stage.isClosed ? "checkmark.circle" : "link")
                }
                .buttonStyle(.plain)
                // A long press: open, change or remove the task, while reading or writing.
                .contextMenu {
                    Button("Open the task", systemImage: "arrow.up.forward") { push(.task(id: task.id)) }
                    Button("Attach to another task", systemImage: "link") { choosingTask = true }
                    Button("Detach from the task", systemImage: "xmark.circle", role: .destructive) {
                        model.attach(to: nil)
                    }
                }
                .accessibilityLabel("Attached to \(task.title)")
                .accessibilityHint("Touch and hold to detach")
                .accessibilityAction(named: "Detach from the task") { model.attach(to: nil) }
            } else {
                Button { choosingTask = true } label: {
                    Label("Attach to a task", systemImage: "link")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.ink2)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .overlay(
                            Capsule().strokeBorder(Theme.line, style: StrokeStyle(lineWidth: 1, dash: [4])))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func chip(_ text: String, icon: String) -> some View {
        Label(text, systemImage: icon)
            .font(.footnote.weight(.medium))
            .foregroundStyle(Theme.ink)
            .lineLimit(1)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Theme.fill, in: Capsule())
    }

    private func footer(_ detail: NoteDetail) -> some View {
        HStack {
            if !detail.attachments.isEmpty {
                Label(
                    detail.attachments.count == 1 ? "1 file" : "\(detail.attachments.count) files",
                    systemImage: "paperclip")
            }
            Spacer()
            Text("Edited \(edited(detail.updatedAt, today: session.day.today))")
        }
        .font(.footnote)
        .foregroundStyle(Theme.ink2)
        .padding(.top, 8)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func open(_ url: URL, _ detail: NoteDetail) -> OpenURLAction.Result {
        let id = url.absoluteString.split(separator: ":", maxSplits: 1).last.map(String.init) ?? ""
        switch url.scheme {
        case "task":
            push(.task(id: id))
        case "project":
            let name = detail.links.first { $0.url == url.absoluteString }?.title ?? "Project"
            push(.scope(.project(id: id), title: name))
        case "attachment":
            if let item = detail.attachments.first(where: { $0.id == id }) {
                Task { preview = await model.open(item) }
            }
        default:
            return .systemAction
        }
        return .handled
    }

    private func share(_ detail: NoteDetail) -> String {
        detail.title.isEmpty ? detail.body : "# \(detail.title)\n\n\(detail.body)"
    }

    // MARK: Writing

    private func editor(_ detail: NoteDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Title", text: $model.title, axis: .vertical)
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Theme.ink)
                .focused($focus, equals: .title)
                .submitLabel(.next)
                .onSubmit { focus = .body }
                .accessibilityIdentifier("noteTitle")
            chips(detail)
            TextEditor(text: $model.body, selection: $selection)
                .font(.body)
                .foregroundStyle(Theme.ink)
                .scrollContentBackground(.hidden)
                .focused($focus, equals: .body)
                .accessibilityIdentifier("noteBody")
                .overlay(alignment: .topLeading) {
                    if model.body.isEmpty {
                        Text("Write in markdown. [[ links a task.")
                            .foregroundStyle(Theme.ink3)
                            .padding(.top, 8).padding(.leading, 5)
                            .allowsHitTesting(false)
                    }
                }
            if let error = model.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
            }
        }
        .padding(.horizontal, 16)
        .overlay(alignment: .bottom) {
            if !model.linkMatches.isEmpty { linkMatches }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) { marks }
        }
    }

    private var linkMatches: some View {
        VStack(spacing: 0) {
            ForEach(model.linkMatches) { task in
                Button {
                    model.link(task)
                    // The link ends the text: the cursor goes after it.
                    selection = TextSelection(insertionPoint: model.body.endIndex)
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: task.stage.isClosed ? "checkmark.circle" : "circle")
                            .foregroundStyle(Theme.ink2)
                        Text(task.title).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer()
                        if let project = task.projectName {
                            HStack(spacing: 5) {
                                Circle().fill(Theme.project(task.projectColor)).frame(width: 8, height: 8)
                                Text(project)
                            }
                            .font(.footnote).foregroundStyle(Theme.ink2)
                        }
                    }
                    .padding(.horizontal, 14)
                    .frame(height: 46)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if task.id != model.linkMatches.last?.id { Divider() }
            }
        }
        .background(Theme.raised, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line))
        .shadow(color: .black.opacity(0.15), radius: 16, y: 6)
        .padding(.horizontal, 12)
        // Above the keyboard bar, which floats over the bottom of the content.
        .padding(.bottom, 64)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Link a task")
    }

    @ViewBuilder
    private var marks: some View {
        Button { insert(line: "## ") } label: { Image(systemName: "textformat.size") }
            .accessibilityLabel("Heading")
        Button { insert("**", "**") } label: { Image(systemName: "bold") }
            .accessibilityLabel("Bold")
        Button { insert(line: "- ") } label: { Image(systemName: "list.bullet") }
            .accessibilityLabel("List")
        Button { insert(line: "- [ ] ") } label: { Image(systemName: "checklist") }
            .accessibilityLabel("Checklist")
        Button { insert("[[") } label: { Image(systemName: "link") }
            .accessibilityLabel("Link a task")
        PhotosPicker(selection: $photo, matching: .images) { Image(systemName: "photo") }
            .accessibilityLabel("Add a photo")
        Spacer()
        Button { focus = nil } label: { Image(systemName: "keyboard.chevron.compact.down") }
            .accessibilityLabel("Hide the keyboard")
    }

    /// Wraps the selection (or puts the marks at the cursor), in the text as it is now.
    private func insert(_ before: String, _ after: String = "") {
        guard focus == .body else {
            model.body += before + after
            return
        }
        var text = model.body
        let (start, end) = offsets(in: text)
        let lower = text.index(text.startIndex, offsetBy: start)
        let upper = text.index(text.startIndex, offsetBy: end)
        let selected = String(text[lower..<upper])
        text.replaceSubrange(lower..<upper, with: before + selected + after)
        model.body = text
        let cursor = text.index(text.startIndex, offsetBy: start + before.count + selected.count)
        selection = TextSelection(insertionPoint: cursor)
    }

    /// Puts a mark at the start of the cursor's line.
    private func insert(line mark: String) {
        var text = model.body
        let (start, _) = offsets(in: text)
        let cursor = text.index(text.startIndex, offsetBy: start)
        let lineStart = text[..<cursor].lastIndex(of: "\n").map { text.index(after: $0) } ?? text.startIndex
        let at = text.distance(from: text.startIndex, to: lineStart)
        text.insert(contentsOf: mark, at: lineStart)
        model.body = text
        selection = TextSelection(
            insertionPoint: text.index(text.startIndex, offsetBy: max(start, at) + mark.count))
    }

    /// The selection as character offsets, clamped to the text (the end when none).
    private func offsets(in text: String) -> (Int, Int) {
        let count = text.count
        guard case .selection(let range) = selection?.indices,
            range.lowerBound >= text.startIndex, range.upperBound <= text.endIndex
        else { return (count, count) }
        let start = text.distance(from: text.startIndex, to: range.lowerBound)
        let end = text.distance(from: text.startIndex, to: range.upperBound)
        return (min(start, count), min(end, count))
    }

    /// Writes the picked photo to a temporary file and adds it to the note.
    private func attach(_ item: PhotosPickerItem) async {
        defer { photo = nil }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("Photo \(Date().formatted(.iso8601)).\(ext)")
        do {
            try data.write(to: file)
            model.attachPhoto(file)
            try? FileManager.default.removeItem(at: file)
        } catch {}
    }
}

/// A note's markdown, drawn: headings, paragraphs, lists, checklists that tick, quotes,
/// code, task and project links as marked links, and embedded files as buttons.
struct NoteMarkdown: View {
    let source: String
    let links: [NoteLink]
    let attachments: [AttachmentItem]
    let fetching: String?
    let toggle: (Int) -> Void
    let open: (AttachmentItem) -> Void

    private enum Block {
        case heading(Int, String)
        case paragraph(String)
        case bullet(String, indent: Int)
        case numbered(String, String, indent: Int)
        case check(Bool, String, line: Int, indent: Int)
        case quote(String)
        case code(String)
        case file(String)
        case gap
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(block)
            }
        }
        .foregroundStyle(Theme.ink)
        .tint(Theme.accentText)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [Block] {
        var out: [Block] = []
        var code: [String]?
        for (index, raw) in source.components(separatedBy: "\n").enumerated() {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let lines = code {
                    out.append(.code(lines.joined(separator: "\n")))
                    code = nil
                } else {
                    code = []
                }
                continue
            }
            if code != nil {
                code?.append(raw)
                continue
            }
            let indent = raw.prefix { $0 == " " || $0 == "\t" }.count / 2
            if trimmed.isEmpty {
                if case .gap = out.last {} else if !out.isEmpty { out.append(.gap) }
            } else if let level = heading(trimmed) {
                out.append(.heading(level, String(trimmed.drop { $0 == "#" }).trimmingCharacters(in: .whitespaces)))
            } else if let file = embeddedFile(trimmed) {
                out.append(.file(file))
            } else if let rest = strip(trimmed, ["- [ ] ", "* [ ] "]) {
                out.append(.check(false, rest, line: index, indent: indent))
            } else if let rest = strip(trimmed, ["- [x] ", "- [X] ", "* [x] "]) {
                out.append(.check(true, rest, line: index, indent: indent))
            } else if let rest = strip(trimmed, ["- ", "* ", "+ "]) {
                out.append(.bullet(rest, indent: indent))
            } else if let match = trimmed.firstMatch(of: /^(\d+)[.)] (.*)$/) {
                out.append(.numbered(String(match.1), String(match.2), indent: indent))
            } else if let rest = strip(trimmed, ["> ", ">"]) {
                out.append(.quote(rest))
            } else {
                out.append(.paragraph(raw))
            }
        }
        if let lines = code { out.append(.code(lines.joined(separator: "\n"))) }
        return out
    }

    @ViewBuilder
    private func view(_ block: Block) -> some View {
        switch block {
        case .heading(let level, let text):
            inline(text)
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .padding(.top, 6)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            inline(text)
        case .bullet(let text, let indent):
            marked(Text("•").foregroundStyle(Theme.ink2), text, indent: indent)
        case .numbered(let number, let text, let indent):
            marked(Text("\(number).").foregroundStyle(Theme.ink2).monospacedDigit(), text, indent: indent)
        case .check(let done, let text, let line, let indent):
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Button { toggle(line) } label: {
                    Image(systemName: done ? "checkmark.square.fill" : "square")
                        .foregroundStyle(done ? Theme.accent : Theme.ink3)
                        .font(.title3)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(done ? "Done" : "Not done")
                inline(text)
                    .foregroundStyle(done ? Theme.ink2 : Theme.ink)
                    .strikethrough(done, color: Theme.ink3)
            }
            .padding(.leading, CGFloat(indent) * 18)
        case .quote(let text):
            inline(text)
                .foregroundStyle(Theme.ink2)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 3) }
        case .code(let text):
            Text(text)
                .font(.system(.callout, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.fill, in: RoundedRectangle(cornerRadius: 8))
        case .file(let id):
            if let item = attachments.first(where: { $0.id == id }) {
                Button { open(item) } label: {
                    HStack(spacing: 10) {
                        if fetching == item.id {
                            ProgressView()
                        } else {
                            Image(systemName: item.mime.hasPrefix("image/") ? "photo" : "doc")
                        }
                        Text(item.name).lineLimit(1)
                        Spacer()
                        Image(systemName: item.onDevice ? "eye" : "icloud.and.arrow.down")
                            .foregroundStyle(Theme.ink3)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 48)
                    .background(Theme.fill, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
            }
        case .gap:
            Color.clear.frame(height: 4)
        }
    }

    private func marked(_ mark: Text, _ text: String, indent: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            mark
            inline(text)
        }
        .padding(.leading, 4 + CGFloat(indent) * 18)
    }

    private func heading(_ line: String) -> Int? {
        let level = line.prefix { $0 == "#" }.count
        return (1...6).contains(level) && line.dropFirst(level).hasPrefix(" ") ? level : nil
    }

    private func strip(_ line: String, _ marks: [String]) -> String? {
        marks.first { line.hasPrefix($0) }.map { String(line.dropFirst($0.count)) }
    }

    /// The attachment id of a line that is only `![name](attachment:<id>)`.
    private func embeddedFile(_ line: String) -> String? {
        line.firstMatch(of: /^!\[[^\]]*\]\(attachment:([^)\s]+)\)$/).map { String($0.1) }
    }

    /// Inline markdown, with task and project links named as they are now: a task's
    /// mark (open or done) or a project's dot before the name.
    private func inline(_ text: String) -> Text {
        let named = text.replacing(/\[([^\]]*)\]\((task|project):([^)\s]+)\)/) { match in
            let url = "\(match.2):\(match.3)"
            guard let link = links.first(where: { $0.url == url }) else { return String(match.0) }
            let mark: String
            if link.kind == .project {
                mark = "●"
            } else {
                mark = link.stage?.isClosed == true ? "✓" : "○"
            }
            let title = link.title.replacingOccurrences(of: "]", with: ")")
            return "[\(mark) \(title)](\(url))"
        }
        guard
            var styled = try? AttributedString(
                markdown: named, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else { return Text(text) }
        for run in styled.runs where run.link != nil {
            styled[run.range].foregroundColor = Theme.accentText
        }
        return Text(styled)
    }
}

/// Picks a task to attach a note to, searching titles as you type.
struct TaskPicker: View {
    let pick: (String) -> Void
    private let today: String
    @State private var search: SearchModel
    @Environment(\.dismiss) private var dismiss

    init(session: Session, pick: @escaping (String) -> Void) {
        self.pick = pick
        today = session.day.today
        _search = State(initialValue: SearchModel(session: session))
    }

    var body: some View {
        NavigationStack {
            List {
                if !search.text.trimmingCharacters(in: .whitespaces).isEmpty {
                    SearchOptionsBar(search: search)
                }
                ForEach(search.results) { task in
                    Button {
                        pick(task.id)
                        dismiss()
                    } label: {
                        // The rows of the Search tab, picked as a whole.
                        TaskRowView(task: task, today: today, showStatus: true, toggle: nil)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
                    .alignmentGuide(.listRowSeparatorLeading) { _ in 52 }
                }
            }
            .listStyle(.plain)
            .overlay {
                if search.text.trimmingCharacters(in: .whitespaces).isEmpty {
                    ContentUnavailableView("Find a task", systemImage: "magnifyingglass")
                } else if search.results.isEmpty {
                    SearchEmptyView(search: search)
                }
            }
            .searchable(text: $search.text, placement: .navigationBarDrawer(displayMode: .always), prompt: "Tasks")
            .navigationTitle("Attach to a task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }
}

/// A new personal project: its name, one of the desktop's colours, and the top-level
/// project it sits in, if any.
struct NewProjectView: View {
    let nav: NavigationModel
    let created: (String) -> Void
    @State private var name = ""
    @State private var color: String? = NewProjectView.colors[5]
    @State private var parentId: String?
    @FocusState private var nameFocused: Bool
    @Environment(\.dismiss) private var dismiss

    /// The desktop's palette (apps/desktop/src/features/organize/projectColors.ts).
    static let colors = [
        "#ef4444", "#f97316", "#f59e0b", "#22c55e", "#14b8a6",
        "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#64748b",
    ]

    private var trimmed: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(spacing: 14) {
                        RoundedRectangle(cornerRadius: 20)
                            .fill(Theme.project(color).opacity(0.16))
                            .frame(width: 64, height: 64)
                            .overlay(Circle().fill(Theme.project(color)).frame(width: 22, height: 22))
                        TextField("Project name", text: $name)
                            .font(.title3.weight(.semibold))
                            .multilineTextAlignment(.center)
                            .focused($nameFocused)
                            .submitLabel(.done)
                            .onSubmit(create)
                            .accessibilityIdentifier("projectName")
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                Section("Colour") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5), spacing: 8) {
                        ForEach(NewProjectView.colors, id: \.self) { hex in
                            Button { color = hex } label: {
                                Circle()
                                    .fill(Theme.project(hex))
                                    .frame(width: 32, height: 32)
                                    .padding(4)
                                    .overlay(
                                        Circle().strokeBorder(Theme.ink, lineWidth: color == hex ? 2.5 : 0))
                                    .frame(width: 44, height: 44)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(hex)
                            .accessibilityAddTraits(color == hex ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section {
                    area(nil, name: "Nothing (top level)", color: nil)
                    ForEach(nav.areas) { project in
                        area(project.id, name: project.name, color: project.color)
                    }
                } header: {
                    Text("Inside")
                } footer: {
                    if let parent = nav.areas.first(where: { $0.id == parentId }) {
                        Text("\(trimmed.isEmpty ? "It" : trimmed) will show under \(parent.name), here and on the desktop.")
                    }
                }
                if let error = nav.error {
                    Text(error).font(.footnote).foregroundStyle(Theme.danger)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.grouped)
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create", action: create)
                        .disabled(trimmed.isEmpty)
                        .accessibilityIdentifier("createProject")
                }
            }
            .onAppear { nameFocused = true }
        }
    }

    private func area(_ id: String?, name: String, color: String?) -> some View {
        Button { parentId = id } label: {
            HStack(spacing: 12) {
                Circle().fill(id == nil ? Theme.line : Theme.project(color)).frame(width: 10, height: 10)
                Text(name).foregroundStyle(Theme.ink)
                Spacer()
                if parentId == id {
                    Image(systemName: "checkmark").foregroundStyle(Theme.accentText).fontWeight(.semibold)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(parentId == id ? .isSelected : [])
    }

    private func create() {
        guard !trimmed.isEmpty,
            let id = nav.createProject(trimmed, color: color, parentId: parentId)
        else { return }
        created(id)
        dismiss()
    }
}
