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

    /// The redirect the identity provider sends the sign-in back to. Registered with it
    /// for the phone (docs/ios-plan.md 4.1).
    public nonisolated static let signInRedirect = "taskmaster://oidc/callback"

    /// Signs in with the server's identity provider. `present` shows the provider's page
    /// in the system sign-in sheet and returns the URL it came back with.
    public func signIn(present: @escaping @MainActor (URL) async throws -> URL) async {
        let core = session.core
        busy = true
        defer { busy = false }
        do {
            let flow = try await Task.detached { try core.signIn(redirect: SyncModel.signInRedirect) }.value
            guard let page = URL(string: flow.page()) else {
                error = "the provider's sign-in address is invalid"
                return
            }
            let back = try await present(page)
            status = try await Task.detached { try flow.finish(redirectUrl: back.absoluteString) }.value
            error = nil
        } catch {
            self.error = describe(error)
        }
    }

    /// What to tell the user when the database versions differ, else nil.
    public var updateMessage: String? {
        switch status.update {
        case .app: "The server runs a newer version. Update the app to sync; your changes stay on this phone meanwhile."
        case .server: "This app is newer than the server. Update the server to sync again."
        case nil: nil
        }
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
