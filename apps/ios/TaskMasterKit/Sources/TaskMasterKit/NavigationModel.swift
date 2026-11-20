import Foundation
import Observation

/// The navigation: list counts, projects and their epics, tags, saved views, and the
/// statuses the pickers offer. Reloads after every change.
@MainActor
@Observable
public final class NavigationModel {
    public private(set) var navigation: Navigation
    public private(set) var error: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session) {
        self.session = session
        self.navigation = Navigation(
            counts: Counts(inbox: 0, today: 0, overdue: 0), projects: [], looseEpics: [],
            tags: [], views: [], statuses: [])
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public var counts: Counts { navigation.counts }
    public var projects: [ProjectItem] { navigation.projects }
    public var looseEpics: [EpicItem] { navigation.looseEpics }
    public var tags: [TagItem] { navigation.tags }
    public var views: [SavedView] { navigation.views }
    public var statuses: [StatusItem] { navigation.statuses }

    /// Every epic, with the project it belongs to (for the epic picker).
    public var epics: [(project: ProjectItem?, epic: EpicItem)] {
        projects.flatMap { project in project.epics.map { (project, $0) } }
            + looseEpics.map { (nil, $0) }
    }

    public func reload() {
        error = failure { navigation = try session.core.navigation(day: session.day) }
    }

    /// Makes a tag (or finds the one named so). Its id, or nil when it failed.
    public func createTag(_ name: String) -> String? {
        var id: String?
        error = failure { id = try session.core.createTag(name: name) }
        return id
    }
}
