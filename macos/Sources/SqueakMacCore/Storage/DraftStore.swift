import Foundation

/// Per-session unsent text, kept in the encrypted container so it survives
/// quitting, going offline and relaunching. Drafts are never sent automatically.
public struct DraftStore: Sendable {
    private let cache: EncryptedCache

    public init(cache: EncryptedCache) {
        self.cache = cache
    }

    public func save(_ text: String, for key: SessionKey) async throws {
        try await cache.setDraft(text, for: key)
    }

    public func load(for key: SessionKey) async throws -> String? {
        try await cache.draft(for: key)
    }

    public func clear(for key: SessionKey) async throws {
        try await cache.setDraft(nil, for: key)
    }

    public func all() async throws -> [SessionKey: String] {
        try await cache.allDrafts()
    }
}

/// What a send does to the typed draft. Choosing a lettered option answers the agent and sends only the
/// letter: whatever is being typed in the composer is a different message and must stay.
public enum DraftPolicy {
    public static func clearsDraft(answering: Bool, requested: Bool) -> Bool {
        requested && !answering
    }
}
