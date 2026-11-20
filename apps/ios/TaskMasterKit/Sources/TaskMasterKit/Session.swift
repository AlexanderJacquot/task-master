import Foundation
@_exported import TaskMasterFFI

/// The app's one connection to the Rust core: the database, sync, and the news that
/// something changed. Screen models are built on it.
@MainActor
public final class Session {
    public let core: Core
    private let clock: @Sendable () -> Date
    private let timeZone: @Sendable () -> TimeZone
    private var dataObservers: [UUID: @MainActor () -> Void] = [:]
    private var syncObservers: [UUID: @MainActor (SyncStatus) -> Void] = [:]
    private var bridge: Bridge?

    /// Opens (or creates) the database in `directory`.
    public convenience init(
        directory: URL,
        deviceName: String,
        clock: @escaping @Sendable () -> Date = { Date() },
        timeZone: @escaping @Sendable () -> TimeZone = { .current }
    ) throws {
        try self.init(
            core: Core.open(dir: directory.path, deviceName: deviceName), clock: clock,
            timeZone: timeZone)
    }

    /// Over a core already open (the process's shared one, `SharedStore.core`).
    public init(
        core: Core,
        clock: @escaping @Sendable () -> Date = { Date() },
        timeZone: @escaping @Sendable () -> TimeZone = { .current }
    ) {
        self.core = core
        self.clock = clock
        self.timeZone = timeZone
        let bridge = Bridge(session: self)
        self.bridge = bridge
        core.setListener(listener: bridge)
    }

    /// Starts background sync. Call once the first screen is up.
    public func start() throws {
        try core.start()
    }

    /// A sync round iOS granted while the app is in the background (background app
    /// refresh): syncs, then leaves the database file complete. Returns the status.
    public func refreshInBackground() async -> SyncStatus {
        let core = self.core
        let status = await Task.detached { core.syncNow() }.value
        suspend()
        return status
    }

    /// The app is going to the background: leave the database file complete.
    public func suspend() {
        try? core.suspend()
    }

    /// The app is back: pick up what an extension wrote meanwhile, and sync soon.
    public func resume() {
        try? core.resume()
    }

    /// The current time, in the core's unit (Unix ms).
    public var nowMs: Int64 { Session.ms(clock()) }

    public nonisolated static func ms(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    public nonisolated static func date(_ ms: Int64) -> Date {
        Date(timeIntervalSince1970: Double(ms) / 1000)
    }

    /// The user's calendar day, which "today" and "overdue" count from.
    public var day: Day {
        Session.day(at: clock(), in: timeZone())
    }

    public nonisolated static func day(at date: Date, in zone: TimeZone) -> Day {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        let pad = { (n: Int, width: Int) -> String in
            let digits = String(n)
            return String(repeating: "0", count: max(0, width - digits.count)) + digits
        }
        let today = "\(pad(parts.year ?? 1970, 4))-\(pad(parts.month ?? 1, 2))-\(pad(parts.day ?? 1, 2))"
        return Day(today: today, utcOffsetMin: Int32(zone.secondsFromGMT(for: date) / 60))
    }

    /// Calls `body` on the main actor after every change to the data, from this phone or
    /// from sync. Keep the token; dropping it stops the calls.
    public func onDataChanged(_ body: @escaping @MainActor () -> Void) -> Observation {
        let id = UUID()
        dataObservers[id] = body
        return Observation { [weak self] in self?.dataObservers[id] = nil }
    }

    /// Calls `body` on the main actor when a sync round starts or ends, or the account changes.
    public func onSyncChanged(_ body: @escaping @MainActor (SyncStatus) -> Void) -> Observation {
        let id = UUID()
        syncObservers[id] = body
        return Observation { [weak self] in self?.syncObservers[id] = nil }
    }

    fileprivate func dataChanged() {
        for body in dataObservers.values { body() }
    }

    fileprivate func syncChanged(_ status: SyncStatus) {
        for body in syncObservers.values { body(status) }
    }

    /// Stops an observer when released.
    @MainActor
    public final class Observation {
        private let cancel: @MainActor () -> Void
        fileprivate init(cancel: @escaping @MainActor () -> Void) { self.cancel = cancel }
        public func stop() { cancel() }
        deinit {
            let cancel = self.cancel
            Task { @MainActor in cancel() }
        }
    }
}

/// Rust calls this from its own threads; everything is passed on to the main actor.
private final class Bridge: Listener, @unchecked Sendable {
    private weak var session: Session?

    init(session: Session) { self.session = session }

    func dataChanged() {
        Task { @MainActor [weak self] in self?.session?.dataChanged() }
    }

    func syncChanged(status: SyncStatus) {
        Task { @MainActor [weak self] in self?.session?.syncChanged(status) }
    }
}

extension TaskRow: Identifiable {}
extension ProjectItem: Identifiable {}
extension EpicItem: Identifiable {}
extension TagItem: Identifiable {}
extension SavedView: Identifiable {}
extension StatusItem: Identifiable {}
extension AttachmentItem: Identifiable {}
extension BlockItem: Identifiable {}
extension TaskRef: Identifiable {}

extension Stage {
    /// Done or cancelled.
    public var isClosed: Bool { self == .done || self == .cancelled }
}

extension AppError {
    /// The sentence to show the user.
    public var message: String {
        switch self {
        case .Invalid(let message), .NotFound(let message), .Internal(let message): message
        }
    }
}

func describe(_ error: Error) -> String {
    (error as? AppError)?.message ?? error.localizedDescription
}

/// Runs `body`; the error in words when it throws, nil when it worked. Screen models keep
/// the last one to show.
func failure(_ body: () throws -> Void) -> String? {
    do {
        try body()
        return nil
    } catch {
        return describe(error)
    }
}
