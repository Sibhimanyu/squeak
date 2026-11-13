import Foundation

/// A thread someone else started in a shared pond that this person hid from their own view. Only the person's own
/// view changes: the thread stays in the pond for everyone else. Kept on this Mac with the words needed to list it
/// even when the pond's data has not loaded.
public struct SharedThreadHide: Codable, Sendable, Equatable {
    public var threadId: String
    public var pondId: String
    public var pondName: String
    public var title: String
    public var agent: String?
    public var hiddenAt: Date

    public init(threadId: String, pondId: String, pondName: String, title: String, agent: String? = nil, hiddenAt: Date) {
        self.threadId = threadId; self.pondId = pondId; self.pondName = pondName; self.title = title; self.agent = agent; self.hiddenAt = hiddenAt
    }
}

/// The set of shared-pond threads this person hid (by pond thread id), stored as one small JSON value.
public struct SharedThreadHides: Codable, Sendable, Equatable {
    public private(set) var hides: [String: SharedThreadHide] = [:]
    public init() {}

    public func isHidden(_ threadId: String) -> Bool { hides[threadId] != nil }
    public var hiddenIds: Set<String> { Set(hides.keys) }
    public var all: [SharedThreadHide] { Array(hides.values) }

    public mutating func hide(_ h: SharedThreadHide) { if hides[h.threadId] == nil { hides[h.threadId] = h } }
    public mutating func unhide(_ threadId: String) { hides[threadId] = nil }
}

/// One line of the Archived page: an archived thread of any kind.
public struct ArchivedEntry: Identifiable, Sendable, Equatable {
    public enum Target: Sendable, Equatable {
        case session(SessionKey)
        case shared(pondId: String, threadId: String)
    }
    public var id: String
    public var title: String
    public var pond: String
    public var agent: String?
    public var archivedAt: Date
    public var target: Target
}

/// One pond's archived threads on the page.
public struct ArchivedGroup: Identifiable, Sendable, Equatable {
    public var id: String { pond }
    public var pond: String
    public var entries: [ArchivedEntry]
}

/// The Archived page: every archived thread across all ponds, grouped by pond, newest archived first, searchable.
/// Decided here where CI can test it; the view only draws.
public enum ArchivedPage {
    public static let otherPond = "Other"
    public static let emptyWords = "Nothing archived yet. Archive a thread from its right-click menu (\u{21E7}\u{2318}A) and it waits here."
    public static let noMatchWords = "No archived thread matches that."

    public static func entries(sessions: [HostSession], shared: [SharedThreadHide], title: (HostSession) -> String) -> [ArchivedEntry] {
        let mine = sessions.compactMap { s -> ArchivedEntry? in
            guard let at = s.archivedAt else { return nil }
            return ArchivedEntry(
                id: "session:" + s.key.stringValue, title: title(s), pond: pondName(s.repoName), agent: s.agent, archivedAt: at,
                target: .session(s.key))
        }
        let others = shared.map {
            ArchivedEntry(
                id: "shared:" + $0.threadId, title: $0.title.isEmpty ? "Untitled thread" : $0.title, pond: pondName($0.pondName),
                agent: $0.agent, archivedAt: $0.hiddenAt, target: .shared(pondId: $0.pondId, threadId: $0.threadId))
        }
        return mine + others
    }

    /// The threads matching the query (every word, in the title or the pond name, any case), grouped by pond: ponds by
    /// their newest archived thread (ties by name), threads newest archived first (ties by title).
    public static func groups(
        sessions: [HostSession], shared: [SharedThreadHide] = [], query: String = "", title: (HostSession) -> String = { $0.label }
    ) -> [ArchivedGroup] {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let matching = entries(sessions: sessions, shared: shared, title: title).filter { e in
            let hay = (e.title + " " + e.pond).lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
        let byPond = Dictionary(grouping: matching, by: { $0.pond.lowercased() })
        let groups = byPond.values.map { list -> ArchivedGroup in
            let sorted = list.sorted {
                $0.archivedAt != $1.archivedAt ? $0.archivedAt > $1.archivedAt : $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
            }
            return ArchivedGroup(pond: sorted[0].pond, entries: sorted)
        }
        return groups.sorted {
            let a = $0.entries[0].archivedAt, b = $1.entries[0].archivedAt
            return a != b ? a > b : $0.pond.localizedCaseInsensitiveCompare($1.pond) == .orderedAscending
        }
    }

    /// How many threads are archived in all: the sidebar entry's count.
    public static func count(sessions: [HostSession], shared: [SharedThreadHide]) -> Int {
        sessions.filter { $0.archivedAt != nil }.count + shared.count
    }

    private static func pondName(_ name: String?) -> String {
        let t = name?.trimmingCharacters(in: .whitespaces) ?? ""
        return t.isEmpty ? otherPond : t
    }
}
