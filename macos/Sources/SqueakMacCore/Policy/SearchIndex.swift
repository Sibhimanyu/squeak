import Foundation

public struct SearchHit: Equatable, Sendable {
    public var key: SessionKey
    public var titleMatch: Bool
    /// A message that matched, for a snippet. Never written anywhere; memory only.
    public var messageId: String?
    public var snippet: String?
}

/// Case- and diacritic-insensitive search over session titles and cached messages.
/// Built in memory on demand; nothing here is persisted.
public struct SearchIndex: Sendable {
    private struct Entry: Sendable {
        var key: SessionKey
        var title: String
        var messages: [(id: String, text: String, folded: String)]
        var order: Int
    }

    private let entries: [Entry]

    public init(sessions: [HostSession], messages: [SessionKey: [ChatMessage]]) {
        entries = sessions.enumerated().map { i, s in
            let titles = [s.title, s.distinctTitle ?? ""].joined(separator: " ")
            return Entry(
                key: s.key,
                title: Self.fold(titles),
                messages: (messages[s.key] ?? []).map { ($0.id, $0.text, Self.fold($0.text)) },
                order: i
            )
        }
    }

    static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// Every whitespace-separated term must appear in the session's title or in its
    /// messages. Title matches come first, then catalog order.
    public func search(_ query: String) -> [SearchHit] {
        let terms = Self.fold(query).split(whereSeparator: \.isWhitespace).map(String.init)
        guard !terms.isEmpty else { return [] }
        var hits: [(SearchHit, Int)] = []
        for e in entries {
            let all = terms.allSatisfy { t in
                e.title.contains(t) || e.messages.contains { $0.folded.contains(t) }
            }
            guard all else { continue }
            let titleMatch = terms.allSatisfy { e.title.contains($0) }
            let msg = e.messages.first { m in terms.contains { m.folded.contains($0) } }
            hits.append((
                SearchHit(key: e.key, titleMatch: titleMatch, messageId: msg?.id, snippet: msg.map { Self.snippet($0.text, terms: terms) }),
                e.order
            ))
        }
        return hits.sorted { a, b in
            if a.0.titleMatch != b.0.titleMatch { return a.0.titleMatch }
            return a.1 < b.1
        }.map(\.0)
    }

    private static func snippet(_ text: String, terms: [String]) -> String {
        let flat = text.replacingOccurrences(of: "\n", with: " ")
        guard let term = terms.first,
              let r = flat.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) else { return String(flat.prefix(120)) }
        let start = flat.index(r.lowerBound, offsetBy: -40, limitedBy: flat.startIndex) ?? flat.startIndex
        let end = flat.index(r.upperBound, offsetBy: 80, limitedBy: flat.endIndex) ?? flat.endIndex
        return String(flat[start..<end])
    }
}
