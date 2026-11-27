import Foundation

/// Where the app keeps its data, and the one `Core` per process over it.
///
/// The database lives in the App Group container so the widgets, the share extension and
/// App Intents open the same file (docs/ios-plan.md P5). Each process opens one `Core`;
/// SQLite and the core handle several processes on one file (`PRAGMA data_version`), and
/// the app picks up their writes when it comes back (`Core.resume`).
public enum SharedStore {
    /// Registered for the app and its extensions (docs/ios-plan.md 4.1).
    public static let appGroup = "group.space.solarnexus.taskmaster"
    /// The folder's name inside the container (and in Application Support before).
    static let folder = "TaskMaster"
    /// The files a data folder holds, moved together.
    static let entries = [
        "tasks.sqlite", "tasks.sqlite-wal", "tasks.sqlite-shm", "account.json", "attachments",
        "backups",
    ]

    /// The data folder: in the App Group container when this process has the group
    /// (otherwise, e.g. an unsigned test build, in Application Support). Data left in
    /// Application Support by an older build moves into the container once.
    public static func directory(
        group: URL? = groupContainer(),
        legacy: URL? = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    ) throws -> URL {
        let files = FileManager.default
        guard let group else {
            guard let legacy else { throw CocoaError(.fileNoSuchFile) }
            return legacy.appendingPathComponent(folder)
        }
        let target = group.appendingPathComponent(folder)
        if let legacy {
            let old = legacy.appendingPathComponent(folder)
            let hasOld = files.fileExists(atPath: old.appendingPathComponent("tasks.sqlite").path)
            let hasNew = files.fileExists(atPath: target.appendingPathComponent("tasks.sqlite").path)
            if hasOld && !hasNew {
                try files.createDirectory(at: target, withIntermediateDirectories: true)
                for name in entries where files.fileExists(atPath: old.appendingPathComponent(name).path) {
                    try files.moveItem(
                        at: old.appendingPathComponent(name), to: target.appendingPathComponent(name))
                }
            }
        }
        return target
    }

    /// The App Group container, when this process has the group. Linux (where the kit's
    /// tests also run) has no such thing.
    public static func groupContainer() -> URL? {
        #if canImport(Darwin)
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
        #else
        nil
        #endif
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var opened: Core?

    /// This process's `Core`, opened on first use. `deviceName` only counts the first time.
    public static func core(deviceName: String) throws -> Core {
        lock.lock()
        defer { lock.unlock() }
        if let opened { return opened }
        let core = try Core.open(dir: directory().path, deviceName: deviceName)
        opened = core
        return core
    }
}
