import Foundation
import Observation

/// The navigation: list counts, projects and their epics, tags, saved views, and the
/// statuses the pickers offer, with the team space's beside the personal ones (ADR 033).
/// Reloads after every change.
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
            tags: [], views: [], statuses: [], team: nil)
        reload()
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public var counts: Counts { navigation.counts }
    public var projects: [ProjectItem] { navigation.projects }
    public var looseEpics: [EpicItem] { navigation.looseEpics }
    public var tags: [TagItem] { navigation.tags }
    public var views: [SavedView] { navigation.views }
    public var statuses: [StatusItem] { navigation.statuses }
    /// The team space, when this phone's token belongs to a member.
    public var team: TeamNav? { navigation.team }

    /// Personal projects (with `team` false) or the team's.
    public func projects(team: Bool) -> [ProjectItem] { projects.filter { $0.team == team } }

    /// Tags a task of that space can take: a team task takes team tags only.
    public func tags(team: Bool) -> [TagItem] { tags.filter { $0.team == team } }

    /// The statuses a task of that space can take.
    public func statuses(team: Bool) -> [StatusItem] {
        team ? (navigation.team?.statuses ?? statuses) : statuses
    }

    /// Epics of that space, with their project.
    public func epics(team: Bool) -> [(project: ProjectItem?, epic: EpicItem)] {
        epics.filter { $0.epic.team == team }
    }

    /// Every epic, with the project it belongs to (for the epic picker).
    public var epics: [(project: ProjectItem?, epic: EpicItem)] {
        projects.flatMap { project in project.epics.map { (project, $0) } }
            + looseEpics.map { (nil, $0) }
    }

    public func reload() {
        error = failure { navigation = try session.core.navigation(day: session.day) }
    }

    /// Makes a tag (or finds the one named so), in the space of `taskId` when given. Its
    /// id, or nil when it failed.
    public func createTag(_ name: String, for taskId: String? = nil) -> String? {
        var id: String?
        error = failure { id = try session.core.createTag(name: name, forTaskId: taskId) }
        return id
    }

    /// Makes a personal project (inside a top-level one when `parentId` is given). Its
    /// id, or nil when it failed.
    public func createProject(_ name: String, color: String?, parentId: String?) -> String? {
        var id: String?
        error = failure {
            id = try session.core.createProject(
                input: NewProjectInput(name: name, color: color, parentId: parentId))
        }
        if id != nil { reload() }
        return id
    }

    /// The projects a new one can go inside: personal top-level ones.
    public var areas: [ProjectItem] { projects.filter { !$0.team && $0.parentId == nil } }
}
