@preconcurrency import CoreSpotlight
import TaskMasterKit
import UniformTypeIdentifiers
import WidgetKit

/// Open tasks in system search (docs/ios-plan.md P5): title, project and due date. The
/// index is rebuilt a moment after changes settle; a result opens its task. The widgets
/// are told to reload at the same moment.
@MainActor
final class Spotlight {
    static let activityType = CSSearchableItemActionType
    private static let domain = "tasks"

    private let session: Session
    private var observation: Session.Observation?
    private var pending: Task<Void, Never>?

    init(session: Session) {
        self.session = session
        observation = session.onDataChanged { [weak self] in self?.soon() }
        refresh()
    }

    static func taskId(in activity: NSUserActivity) -> String? {
        activity.userInfo?[CSSearchableItemActivityIdentifier] as? String
    }

    /// Coalesces a burst of edits (a sync round) into one rebuild.
    private func soon() {
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }

    func refresh() {
        guard CSSearchableIndex.isIndexingAvailable(),
            let rows = try? session.core.list(scope: .all, day: session.day)
        else { return }
        let items = rows.compactMap { row -> CSSearchableItem? in
            guard case .task(let task) = row, !task.stage.isClosed else { return nil }
            let attributes = CSSearchableItemAttributeSet(contentType: .content)
            attributes.title = task.title
            attributes.contentDescription = [
                task.projectName, task.dueDate.map { "Due \($0)" },
            ].compactMap { $0 }.joined(separator: " · ")
            attributes.contentURL = AppLink.task(id: task.id).url
            return CSSearchableItem(
                uniqueIdentifier: task.id, domainIdentifier: Self.domain, attributeSet: attributes)
        }
        WidgetCenter.shared.reloadAllTimelines()
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: [Self.domain]) { _ in
            CSSearchableIndex.default().indexSearchableItems(items)
        }
    }
}
