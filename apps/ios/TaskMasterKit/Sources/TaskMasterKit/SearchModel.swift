import Foundation
import Observation

/// Search over titles and descriptions, as the user types.
@MainActor
@Observable
public final class SearchModel {
    public var text = "" {
        didSet { reload() }
    }
    public private(set) var results: [TaskRow] = []
    public private(set) var error: String?

    @ObservationIgnored private let session: Session
    @ObservationIgnored private var observation: Session.Observation?

    public init(session: Session) {
        self.session = session
        observation = session.onDataChanged { [weak self] in self?.reload() }
    }

    public func reload() {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            results = []
            error = nil
            return
        }
        error = failure { results = try session.core.search(text: text, day: session.day) }
    }
}
