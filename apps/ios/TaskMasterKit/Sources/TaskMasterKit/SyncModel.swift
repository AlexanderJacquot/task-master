import Foundation
import Observation

/// The sync screen: the server account and what the last round did. Every step that
/// talks to the server runs off the main actor.
@MainActor
@Observable
public final class SyncModel {
    public private(set) var status: SyncStatus
    /// A step is waiting on the server.
    public private(set) var busy = false
    public private(set) var error: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session) {
        self.session = session
        self.status = session.core.syncStatus()
        observation = session.onSyncChanged { [weak self] status in self?.status = status }
    }

    /// What the screen should offer next.
    public enum Step: Equatable, Sendable {
        /// No server yet: ask for its address.
        case address
        /// The server wants a token.
        case token
        /// The server wants a sign-in with its identity provider.
        case signIn
        /// Connected; choose how to start (merge, or replace this phone's data).
        case join
        case syncing
    }

    public var step: Step {
        if !status.configured { return .address }
        if status.joined { return .syncing }
        if !status.signedIn {
            switch status.auth {
            case .token: return .token
            case .oidc: return .signIn
            case .some(.none), nil: break
            }
        }
        return .join
    }

    /// Asks the server what it needs when that is not known yet (after a restart).
    public func refresh() async {
        let core = session.core
        status = await Task.detached { core.syncRefresh() }.value
    }

    public func connect(_ address: String) async {
        let core = session.core
        await run { try core.syncConnect(url: address) }
    }

    public func setToken(_ token: String) async {
        let core = session.core
        await run { try core.syncSetToken(token: token) }
    }

    public func join(_ mode: JoinMode) async {
        let core = session.core
        await run { try core.syncJoin(mode: mode) }
    }

    /// Syncs and returns when done (pull to refresh).
    public func syncNow() async {
        let core = session.core
        await run { core.syncNow() }
    }

    public func disconnect() async {
        let core = session.core
        await run { try core.syncDisconnect() }
    }

    private func run(_ step: @escaping @Sendable () throws -> SyncStatus) async {
        busy = true
        defer { busy = false }
        do {
            status = try await Task.detached(operation: step).value
            error = nil
        } catch {
            self.error = describe(error)
        }
    }
}
