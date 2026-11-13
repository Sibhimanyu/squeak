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

/// What a changed set of drafts needs written: the quick composer saves only the difference.
public enum DraftSync {
    public static func changes(old: [SessionKey: String], new: [SessionKey: String]) -> (save: [SessionKey: String], clear: [SessionKey]) {
        (new.filter { old[$0.key] != $0.value }, old.keys.filter { new[$0] == nil })
    }
}

/// The last write before the app quits (an update's relaunch): runs off the main thread and blocks the caller for at
/// most `timeout`, so a draft is on disk before the process goes without a stuck quit if the disk is slow.
public enum DraftFlush {
    /// True when `work` finished inside the timeout.
    @discardableResult
    public static func waitFor(timeout: TimeInterval = 1, _ work: @escaping @Sendable () async -> Void) -> Bool {
        let done = DispatchSemaphore(value: 0)
        Task.detached { await work(); done.signal() }
        return done.wait(timeout: .now() + timeout) == .success
    }

    /// Brings the store to exactly `entries`: what changed is saved, what went is cleared. Idempotent.
    public static func reconcile(_ store: DraftStore, to entries: [SessionKey: String]) async {
        let old = (try? await store.all()) ?? [:]
        let c = DraftSync.changes(old: old, new: entries)
        for (k, v) in c.save { try? await store.save(v, for: k) }
        for k in c.clear { try? await store.clear(for: k) }
    }
}
