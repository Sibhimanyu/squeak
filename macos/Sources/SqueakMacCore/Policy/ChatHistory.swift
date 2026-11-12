import Foundation

// DESIGN.md §8.10, the "Chat history" popover at the right end of a workspace's tab strip: every chat of the pond,
// newest first, filtered by title and by what was said (the host's `GET /native/search`). Pure rules here.

/// One hit from the host's search: where the words sit in a one-line excerpt.
public struct ChatSearchHit: Sendable, Equatable, Decodable {
    public var sessionId: String
    /// `title` or `message`.
    public var `in`: String
    public var snippet: String
    public var start: Int
    public var length: Int

    public init(sessionId: String, in place: String, snippet: String, start: Int, length: Int) {
        self.sessionId = sessionId
        self.in = place
        self.snippet = snippet
        self.start = start
        self.length = length
    }
}

extension NativeHostClient {
    private struct SearchAnswer: Decodable { var results: [ChatSearchHit] }

    /// Chats of a project (nil: all) whose title or message text holds every word. Throws on a host without the route.
    public func search(query: String, projectId: String?, limit: Int = 50) async throws -> [ChatSearchHit] {
        var path = "/native/search?q=\(Self.id(query))&limit=\(limit)"
        if let projectId { path += "&project=\(Self.id(projectId))" }
        return try JSONDecoder().decode(SearchAnswer.self, from: try await call("GET", path, timeout: 10)).results
    }
}

public struct ChatHistoryRow: Sendable, Equatable, Identifiable {
    public var key: SessionKey
    public var title: String
    /// "workspace · branch" (the branch only when it says more than the name).
    public var place: String
    public var agent: String?
    public var state: SessionState
    public var lastActivityAt: Date?
    /// The excerpt with the matched words' range, or the chat's last words when nothing was typed.
    public var snippet: String?
    public var highlight: Range<Int>?
    public var id: SessionKey { key }
}

public enum ChatHistory {
    /// Rows for `chats` (each with its title and workspace label), newest first by last activity, ties by title.
    /// With a query: a chat stays when its title holds every word, or the host found the words in it (`hits`, by the
    /// host's session id); the host's excerpt wins over the fallback.
    public static func rows(
        chats: [(session: HostSession, title: String, place: String)], query: String, hits: [ChatSearchHit] = [],
        fallbackSnippet: (HostSession) -> String? = { _ in nil }
    ) -> [ChatHistoryRow] {
        let words = Self.words(query)
        let byId = Dictionary(hits.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
        var out: [ChatHistoryRow] = []
        for c in chats {
            let hit = byId[c.session.key.hostSessionId]
            var snippet = fallbackSnippet(c.session)
            var range: Range<Int>?
            if !words.isEmpty {
                let lower = c.title.lowercased()
                let titleMatches = words.allSatisfy { lower.contains($0) }
                guard titleMatches || hit != nil else { continue }
                if let hit, hit.in == "message" {
                    snippet = hit.snippet
                    range = hit.start..<(hit.start + hit.length)
                }
            }
            out.append(
                ChatHistoryRow(
                    key: c.session.key, title: c.title, place: c.place, agent: c.session.agent, state: c.session.state,
                    lastActivityAt: c.session.lastActivityAt, snippet: snippet, highlight: range))
        }
        return out.sorted {
            switch ($0.lastActivityAt, $1.lastActivityAt) {
            case let (a?, b?) where a != b: return a > b
            case (_?, nil): return true
            case (nil, _?): return false
            default: return $0.title.localizedStandardCompare($1.title) == .orderedAscending
            }
        }
    }

    public static func words(_ query: String) -> [String] {
        query.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "_" }).map(String.init)
    }

    /// The row an arrow key lands on: stays inside the list (no wrapping); the first row when none is selected.
    public static func move(from selected: SessionKey?, in rows: [ChatHistoryRow], by delta: Int) -> SessionKey? {
        guard !rows.isEmpty else { return nil }
        guard let selected, let i = rows.firstIndex(where: { $0.key == selected }) else { return rows.first?.key }
        return rows[min(rows.count - 1, max(0, i + delta))].key
    }

    /// The selection after the list changed: kept when still there, else the first row.
    public static func reselect(_ selected: SessionKey?, in rows: [ChatHistoryRow]) -> SessionKey? {
        if let selected, rows.contains(where: { $0.key == selected }) { return selected }
        return rows.first?.key
    }

    /// Return opens the chat as a tab and leaves; ⌘Return opens it and stays.
    public enum Action: Equatable { case open(SessionKey, stay: Bool), none }
    public static func action(selected: SessionKey?, command: Bool) -> Action {
        guard let selected else { return .none }
        return .open(selected, stay: command)
    }
}
