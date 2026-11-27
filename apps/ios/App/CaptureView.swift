import PhotosUI
import SwiftUI
import TaskMasterKit

/// The composer: one quick-capture line (`Call the plumber #home @Home !high ^tomorrow`)
/// over the keyboard, what the markers were read as in tinted chips under it, the project
/// it goes to (the Inbox when none), the Today switch, and a photo to attach. It stays
/// open for the next one, with the same project.
struct CaptureView: View {
    let session: Session
    @State private var capture: CaptureModel
    @State private var nav: NavigationModel
    @State private var photo: PhotosPickerItem?
    @State private var photoData: Data?
    @State private var added: String?
    @State private var creatingProject = false
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    init(session: Session, forToday: Bool) {
        self.session = session
        _capture = State(initialValue: CaptureModel(session: session, forToday: forToday))
        _nav = State(initialValue: NavigationModel(session: session))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                projectMenu
                todaySwitch
                Spacer()
                if let added {
                    Label(added, systemImage: "checkmark.circle.fill")
                        .font(.footnote.weight(.medium))
                        .lineLimit(1)
                        .foregroundStyle(Theme.done)
                        .transition(.opacity)
                        .accessibilityIdentifier("addedNote")
                }
            }

            TextField("What needs doing?", text: $capture.text)
                .font(.title3)
                .foregroundStyle(Theme.ink)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { add() }
                .accessibilityIdentifier("captureField")

            preview

            if let error = capture.error {
                Text(error).font(.footnote).foregroundStyle(Theme.danger)
                    .accessibilityIdentifier("listError")
            }

            Divider().overlay(Theme.line)

            // The picker's label is a Sendable closure: it gets a copy, not the view's state.
            let hasPhoto = photoData != nil
            HStack(spacing: 4) {
                PhotosPicker(selection: $photo, matching: .images) {
                    Image(systemName: hasPhoto ? "photo.badge.checkmark" : "photo")
                        .font(.title3)
                        .foregroundStyle(hasPhoto ? Theme.accentText : Theme.ink2)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(hasPhoto ? "Photo attached" : "Attach a photo")
                Button("More fields") { addAndOpen() }
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Theme.accentText)
                    .disabled(!capture.canAdd)
                    .frame(minHeight: 44)
                Spacer()
                Button { add() } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(capture.canAdd ? Theme.accent : Theme.ink3, in: Circle())
                }
                .disabled(!capture.canAdd)
                .accessibilityLabel("Add task")
                .accessibilityIdentifier("addButton")
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 8)
        .frame(maxHeight: .infinity, alignment: .top)
        .presentationDetents([.height(250)])
        .presentationDragIndicator(.visible)
        .presentationBackground(Theme.raised)
        .onAppear { focused = true }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { photoData = try? await item.loadTransferable(type: Data.self) }
        }
        .sensoryFeedback(.success, trigger: added)
    }

    /// Where the task goes: the Inbox or one of the personal projects (names in the line
    /// resolve against the personal space too). A project typed in the line wins, so the
    /// pick is struck through while there is one.
    private var projectMenu: some View {
        let picked = capture.project
        let overridden = !capture.pickerApplies && picked != nil
        return Menu {
            Picker(
                "Project",
                selection: Binding(
                    get: { capture.project?.id },
                    set: { id in capture.project = nav.projects(team: false).first { $0.id == id } })
            ) {
                Label("Inbox", systemImage: "tray").tag(String?.none)
                ForEach(nav.projects(team: false)) { project in
                    Text(String(repeating: "   ", count: Int(project.depth)) + project.name)
                        .tag(Optional(project.id))
                }
            }
            Divider()
            Button("New project…", systemImage: "plus") { creatingProject = true }
        } label: {
            HStack(spacing: 6) {
                if let picked {
                    Circle().fill(Theme.project(picked.color)).frame(width: 8, height: 8)
                } else {
                    Image(systemName: "tray").imageScale(.small)
                }
                Text(picked?.name ?? "Inbox")
                    .strikethrough(overridden)
                    .lineLimit(1)
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(Theme.ink2)
            }
            .font(.footnote.weight(.semibold))
            .padding(.horizontal, 12)
            .frame(height: 28)
            .foregroundStyle(overridden ? Theme.ink3 : Theme.ink)
            .background(Theme.fill, in: Capsule())
        }
        .accessibilityLabel("Project, \(picked?.name ?? "Inbox")")
        .accessibilityHint(overridden ? "The project typed in the line is used instead" : "Where the task goes")
        .accessibilityIdentifier("captureProject")
        .sheet(isPresented: $creatingProject, onDismiss: { focused = true }) {
            NewProjectView(nav: nav) { id in
                capture.project = nav.projects(team: false).first { $0.id == id }
            }
        }
    }

    /// Picks the new task for today as well.
    private var todaySwitch: some View {
        let on = capture.forToday
        return Button {
            capture.forToday.toggle()
        } label: {
            Label("Today", systemImage: on ? "sun.max.fill" : "sun.max")
                .font(.footnote.weight(on ? .semibold : .medium))
                .padding(.horizontal, 12)
                .frame(height: 28)
                .foregroundStyle(on ? Theme.accentText : Theme.ink)
                .background(on ? Theme.accentSoft : Theme.fill, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityHint("Also plan the task for today")
    }

    /// What the line's markers were read as, each kind in its colour.
    @ViewBuilder
    private var preview: some View {
        if let preview = capture.preview, hasMarkers(preview) {
            FlowLayout(spacing: 6) {
                if let project = preview.project {
                    token(
                        project.known ? project.name : "No project “\(project.name)”",
                        icon: "folder", ink: project.known ? Theme.done : Theme.danger)
                }
                if let epic = preview.epic {
                    token(
                        epic.known ? epic.name : "No epic “\(epic.name)”",
                        icon: "flag.2.crossed", ink: epic.known ? Theme.ink : Theme.danger)
                }
                ForEach(preview.tags, id: \.name) { tag in
                    token(tag.known ? "#\(tag.name)" : "#\(tag.name) (new)", icon: nil, ink: Theme.ink)
                }
                if let priority = preview.priority, priority != .normal {
                    token(priorityName(priority), icon: "flag.fill", ink: Theme.highInk)
                }
                if let due = preview.dueDate {
                    token("Due \(Dates.relative(due, today: session.day.today))", icon: "calendar", ink: Theme.progressInk)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Will be added with: \(summary(preview))")
        } else {
            Text("#tag  @Project  !high  ^tomorrow")
                .font(.footnote.monospaced())
                .foregroundStyle(Theme.ink2)
                .accessibilityLabel("Markers: hash for a tag, at for a project, exclamation for priority, caret for a due date")
        }
    }

    private func token(_ label: String, icon: String?, ink: Color) -> some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).imageScale(.small) }
            Text(label)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(ink)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(Theme.fill, in: Capsule())
    }

    private func hasMarkers(_ p: CapturePreview) -> Bool {
        p.project != nil || p.epic != nil || !p.tags.isEmpty || p.dueDate != nil
            || (p.priority != nil && p.priority != .normal)
    }

    private func summary(_ p: CapturePreview) -> String {
        var parts: [String] = []
        if let project = p.project { parts.append("project \(project.name)") }
        if let epic = p.epic { parts.append("epic \(epic.name)") }
        parts += p.tags.map { "tag \($0.name)" }
        if let priority = p.priority { parts.append(priorityName(priority)) }
        if let due = p.dueDate { parts.append("due \(Dates.relative(due, today: session.day.today))") }
        return parts.joined(separator: ", ")
    }

    private func priorityName(_ priority: Priority) -> String {
        switch priority {
        case .urgent: "Urgent"
        case .high: "High"
        case .normal: "Normal"
        case .low: "Low"
        }
    }

    @discardableResult
    private func add() -> String? {
        guard capture.canAdd else { return nil }
        // The Today switch beside it says the rest; one line fits the header.
        let place = capture.destination ?? (capture.forToday ? "Today" : "Inbox")
        guard let id = capture.add() else { return nil }
        attachPhoto(to: id)
        withAnimation { added = "Added to \(place)" }
        focused = true
        return id
    }

    /// Adds the task and opens it for the fields the line cannot say.
    private func addAndOpen() {
        guard let id = add() else { return }
        dismiss()
        Router.shared.open(.task(id: id))
    }

    private func attachPhoto(to id: String) {
        guard let data = photoData else { return }
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("Photo \(Date().formatted(.iso8601)).jpg")
        if (try? data.write(to: file)) != nil {
            _ = try? session.core.attachFile(taskId: id, path: file.path, name: "")
            try? FileManager.default.removeItem(at: file)
        }
        photoData = nil
        photo = nil
    }
}
