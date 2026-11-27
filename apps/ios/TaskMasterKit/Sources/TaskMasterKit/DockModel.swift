import Foundation
import Observation

/// A button of the tab bar ("the dock"): one of the app's screens, or a pinned project.
public enum DockItem: Hashable, Codable, Sendable {
    case today, inbox, plan, browse, notes, allTasks
    case project(id: String)

    /// The screens that can go in the dock, projects aside.
    public static let screens: [DockItem] = [.today, .inbox, .plan, .browse, .notes, .allTasks]
}

/// The buttons of the tab bar, in order, kept on the phone. Search is always there beside
/// them, and Browse always stays: everything not in the dock is reached from it.
@MainActor
@Observable
public final class DockModel {
    /// Beside Search: with a fifth, iOS makes Search a plain tab behind a "More" one.
    public static let maxItems = 4
    public static let standard: [DockItem] = [.today, .inbox, .plan, .browse]

    public private(set) var items: [DockItem] {
        didSet { save() }
    }

    @ObservationIgnored private let defaults: UserDefaults
    static let key = "dock.items"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let saved = defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([DockItem].self, from: $0) }
        items = Self.valid(saved ?? Self.standard)
    }

    public var isFull: Bool { items.count >= Self.maxItems }
    public var isStandard: Bool { items == Self.standard }

    public func contains(_ item: DockItem) -> Bool { items.contains(item) }

    /// Browse cannot leave the dock.
    public func canRemove(_ item: DockItem) -> Bool { item != .browse }

    /// At the end, when there is room and it is not there yet.
    public func add(_ item: DockItem) {
        guard !isFull, !contains(item) else { return }
        items.append(item)
    }

    public func remove(_ item: DockItem) {
        guard canRemove(item) else { return }
        items.removeAll { $0 == item }
    }

    public func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        var moved = items
        // IndexSet-based move without SwiftUI: take them out, put them back in order.
        let picked = source.sorted().map { moved[$0] }
        let before = source.filter { $0 < destination }.count
        for index in source.sorted(by: >) { moved.remove(at: index) }
        moved.insert(contentsOf: picked, at: destination - before)
        items = moved
    }

    public func reset() { items = Self.standard }

    /// The buttons to show: pinned projects that no longer exist are left out (they come
    /// back if the project does, after a sync for instance).
    public func shown(projectIds: Set<String>) -> [DockItem] {
        items.filter {
            if case .project(let id) = $0 { return projectIds.contains(id) }
            return true
        }
    }

    /// No duplicates, Browse in, at most `maxItems`.
    static func valid(_ items: [DockItem]) -> [DockItem] {
        var seen = Set<DockItem>()
        var out = items.filter { seen.insert($0).inserted }
        if !out.contains(.browse) { out.append(.browse) }
        while out.count > maxItems, let drop = out.lastIndex(where: { $0 != .browse }) {
            out.remove(at: drop)
        }
        return out
    }

    private func save() {
        if let data = try? JSONEncoder().encode(items) { defaults.set(data, forKey: Self.key) }
    }
}
