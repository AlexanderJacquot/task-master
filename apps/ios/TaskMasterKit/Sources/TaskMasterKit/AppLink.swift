import Foundation

/// A place in the app as a `taskmaster://` URL: what notifications, widgets, Spotlight and
/// Shortcuts open. The same scheme brings the identity provider's sign-in back
/// (`taskmaster://oidc/callback`), which is not a place and parses to nil.
public enum AppLink: Equatable, Sendable {
    case task(id: String)
    case inbox
    case today
    case dayPlan

    public static let scheme = "taskmaster"

    public init?(url: URL) {
        guard url.scheme == AppLink.scheme, let host = url.host() else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch (host, parts.count) {
        case ("task", 1): self = .task(id: parts[0])
        case ("inbox", 0): self = .inbox
        case ("today", 0): self = .today
        case ("day", 0): self = .dayPlan
        default: return nil
        }
    }

    public var url: URL {
        switch self {
        case .task(let id):
            let safe = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            return URL(string: "\(AppLink.scheme)://task/\(safe)")!
        case .inbox: return URL(string: "\(AppLink.scheme)://inbox")!
        case .today: return URL(string: "\(AppLink.scheme)://today")!
        case .dayPlan: return URL(string: "\(AppLink.scheme)://day")!
        }
    }
}
