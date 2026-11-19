import Foundation

/// A small least-recently-used map: the newest `capacity` keys stay, a read counts as use.
public struct KeyedLRU<Key: Hashable, Value> {
    public let capacity: Int
    private var values: [Key: Value] = [:]
    private var order: [Key] = []  // oldest first

    public init(capacity: Int) { self.capacity = max(1, capacity) }

    public var keys: [Key] { order }
    public var count: Int { order.count }

    /// The value for `key`, made by `make` when absent; marks it newest and evicts the oldest beyond capacity.
    public mutating func value(for key: Key, make: () -> Value) -> Value {
        if let v = values[key] {
            if order.last != key { order.removeAll { $0 == key }; order.append(key) }
            return v
        }
        let v = make()
        values[key] = v
        order.append(key)
        while order.count > capacity { values[order.removeFirst()] = nil }
        return v
    }

    public mutating func remove(_ key: Key) {
        values[key] = nil
        order.removeAll { $0 == key }
    }
}

/// What one chat's transcript derives from its messages, kept by chat so switching back to a recent chat reuses the
/// built rows instead of rebuilding them. Each cache is keyed by its content, so a stale entry just recomputes.
public final class ChatViewCaches {
    public let rows = ChatRowsCache()
    public let derived = RowDerivedCache()
    public let rowCache = TranscriptRowCache()
    public init() {}
}

/// The per-chat caches of the most recently shown chats (about six).
public final class ChatViewCacheStore {
    private var lru: KeyedLRU<SessionKey, ChatViewCaches>
    public init(capacity: Int = 6) { lru = KeyedLRU(capacity: capacity) }
    public var keys: [SessionKey] { lru.keys }
    public func caches(for key: SessionKey) -> ChatViewCaches { lru.value(for: key) { ChatViewCaches() } }
    public func forget(_ key: SessionKey) { lru.remove(key) }
}
