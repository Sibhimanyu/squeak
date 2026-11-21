import Foundation

/// Unsent composer text for the places that keep it by container (a pond thread, the room, a Squeak chat's open editor):
/// in memory, and in UserDefaults so it survives a relaunch, like the broker's per-chat drafts. Cleared on send.
/// Empty text is no draft. Only the newest `capacity` drafts are kept.
@MainActor
public final class ContainerDrafts {
    public static let shared = ContainerDrafts(defaults: .standard)

    public static func pond(_ pond: String, thread: String) -> String { "pond:\(pond):\(thread)" }
    public static func room(_ id: String) -> String { "room:\(id)" }
    public static func native(_ key: String, item: String? = nil) -> String { item.map { "native:\(key):\($0)" } ?? "native:\(key)" }

    private struct Entry: Codable { var text: String; var at: Date }

    private let defaults: UserDefaults
    private let storageKey: String
    private let capacity: Int
    private var entries: [String: Entry]

    public init(defaults: UserDefaults, storageKey: String = "squeak.composerDrafts", capacity: Int = 60) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.capacity = max(1, capacity)
        if let data = defaults.data(forKey: storageKey), let loaded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            entries = loaded
        } else {
            entries = [:]
        }
    }

    public func draft(for id: String) -> String { entries[id]?.text ?? "" }

    /// The saved draft, or `fallback` when there is none (an edit that starts from the message's own words).
    public func draft(for id: String, fallback: String) -> String { entries[id]?.text ?? fallback }

    public func set(_ text: String, for id: String) {
        if text.isEmpty { clear(id); return }
        guard entries[id]?.text != text else { return }
        entries[id] = Entry(text: text, at: Date())
        if entries.count > capacity {
            for (k, _) in entries.sorted(by: { $0.value.at < $1.value.at }).prefix(entries.count - capacity) { entries[k] = nil }
        }
        persist()
    }

    public func clear(_ id: String) {
        guard entries[id] != nil else { return }
        entries[id] = nil
        persist()
    }

    public var count: Int { entries.count }

    private func persist() {
        if entries.isEmpty { defaults.removeObject(forKey: storageKey) } else if let data = try? JSONEncoder().encode(entries) { defaults.set(data, forKey: storageKey) }
    }
}
