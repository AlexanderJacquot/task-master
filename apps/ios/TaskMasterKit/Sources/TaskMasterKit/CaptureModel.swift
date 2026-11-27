import Foundation
import Observation

/// The capture composer: one quick-capture line, read as it is typed, added to the Inbox
/// or picked for today.
@MainActor
@Observable
public final class CaptureModel {
    public var text = "" {
        didSet { preview = read(text) }
    }
    /// Pick the new task for today (the composer's Today switch).
    public var forToday = false
    /// The composer's project picker; nil files the task in the Inbox. It stays picked
    /// for the next line.
    public var project: ProjectItem?
    /// What the line will make; nil while it is empty.
    public private(set) var preview: CapturePreview?
    public private(set) var error: String?

    @ObservationIgnored private let session: Session

    public init(session: Session, forToday: Bool = false) {
        self.session = session
        self.forToday = forToday
    }

    /// Whether the picker decides the project: a project or epic typed in the line wins.
    public var pickerApplies: Bool {
        preview?.project == nil && preview?.epic == nil
    }

    /// Where the task will go: the typed project, else the picked one; nil for none.
    public var destination: String? {
        if let typed = preview?.project { return typed.known ? typed.name : nil }
        return pickerApplies ? project?.name : nil
    }

    /// Something to add: a title once the markers are taken out.
    public var canAdd: Bool {
        !(preview?.title.trimmingCharacters(in: .whitespaces).isEmpty ?? true)
    }

    /// Adds the task and clears the line, ready for the next one. Its id, or nil when
    /// nothing was added (the reason is in `error`).
    @discardableResult
    public func add() -> String? {
        var id: String?
        error = failure {
            id = try session.core.captureTo(
                text: text, day: session.day, today: forToday, projectId: project?.id)
        }
        if id != nil { text = "" }
        return id
    }

    private func read(_ line: String) -> CapturePreview? {
        guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return try? session.core.previewCapture(text: line, day: session.day)
    }
}
