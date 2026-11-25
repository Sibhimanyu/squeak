import Foundation

// DESIGN.md 8.12: "For you". What in a Pond waits on the person, as one list. The sidebar's yellow badge and the
// Dashboard's "For you" card are both made here from the same input, so the number and the list always agree.
// Pure: the views hand in what the host and the read state say, and only draw the answer.

/// Why an item is for the person.
public enum ForYouReason: Equatable, Sendable {
    /// The Duck is waiting on an answer or an approval.
    case waiting
    /// The Duck finished and the person has not opened its chat yet.
    case unread

    public var line: String {
        switch self {
        case .waiting: "needs you"
        case .unread: "finished, not opened yet"
        }
    }
}

/// One chat of the Pond, as the list needs it.
public struct ForYouChat: Equatable, Sendable {
    public var sessionId: String
    /// The Duck's name; nil when no identity is known (the row then says "A Duck", never the chat's title).
    public var duckName: String?
    public var title: String
    public var unread: Bool
    public var waiting: Bool

    public init(sessionId: String, duckName: String?, title: String, unread: Bool, waiting: Bool) {
        self.sessionId = sessionId; self.duckName = duckName; self.title = title; self.unread = unread; self.waiting = waiting
    }
}

public struct ForYouItem: Equatable, Sendable, Identifiable {
    public var id: String { sessionId }
    public var sessionId: String
    public var name: String
    public var reason: ForYouReason
    /// "Pip: finished, not opened yet".
    public var line: String { "\(name) \u{00B7} \(reason.line)" }
}

public struct PondForYou: Equatable, Sendable {
    public var items: [ForYouItem]
    public var count: Int { items.count }
    /// The card shows only when there is something in it.
    public var isEmpty: Bool { items.isEmpty }

    /// The sidebar's marks for the same list: the yellow badge is exactly this card's count.
    /// `hostNeeds` is the host's own needs-you count for the Pond (it can name more than the chats here do).
    public func marks(hostNeeds: Int = 0) -> PondRowMarks {
        PondRowMarks.of(needsYou: max(hostNeeds, items.filter { $0.reason == .waiting }.count), unread: count)
    }

    /// Waiting Ducks first, then unread chats; each chat once; the input's order otherwise (newest first from the caller).
    public static func build(_ chats: [ForYouChat]) -> PondForYou {
        var seen = Set<String>()
        func item(_ c: ForYouChat, _ r: ForYouReason) -> ForYouItem? {
            guard seen.insert(c.sessionId).inserted else { return nil }
            return ForYouItem(sessionId: c.sessionId, name: c.duckName?.trimmingCharacters(in: .whitespaces).nonEmpty ?? "A Duck", reason: r)
        }
        let waiting = chats.filter(\.waiting).compactMap { item($0, .waiting) }
        let unread = chats.filter(\.unread).compactMap { item($0, .unread) }
        return PondForYou(items: waiting + unread)
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
