import Foundation

/// What a notification remembers about the moment it was posted: which event, when, and (once
/// known) which assistant message and turn it was about. Only opaque ids and times, never text, so
/// it is safe in a notification's `userInfo`. An old notification clicked later must show *its*
/// reply, not whatever the chat said since.
public struct NotificationAnchor: Codable, Sendable, Hashable {
    public var eventId: String
    public var kind: NotificationKind?
    public var at: Date?
    public var messageId: String?
    public var turnId: String?

    public init(eventId: String, kind: NotificationKind? = nil, at: Date? = nil, messageId: String? = nil, turnId: String? = nil) {
        self.eventId = eventId; self.kind = kind; self.at = at; self.messageId = messageId; self.turnId = turnId
    }

    /// The event's own identity, with no message yet. Nil for an event that was never stamped.
    public init?(event: NotificationEvent) {
        guard let id = event.id else { return nil }
        self.init(eventId: id, kind: event.kind, at: event.at)
    }

    public var hasMessageIdentity: Bool { messageId != nil || turnId != nil }

    enum Field {
        static let session = "session", event = "event", kind = "kind", at = "at", message = "message", turn = "turn"
    }

    /// Property-list values only, as `UNNotificationContent.userInfo` requires.
    public func userInfo(session: SessionKey) -> [String: Any] {
        var info: [String: Any] = [Field.session: session.stringValue, Field.event: eventId]
        if let kind { info[Field.kind] = kind.rawValue }
        if let at { info[Field.at] = at.timeIntervalSince1970 }
        if let messageId { info[Field.message] = messageId }
        if let turnId { info[Field.turn] = turnId }
        return info
    }

    /// Nil for a notification posted before events carried identity (the pre-upgrade ones).
    public static func parse(_ info: [AnyHashable: Any]) -> NotificationAnchor? {
        guard let event = info[Field.event] as? String, !event.isEmpty else { return nil }
        return NotificationAnchor(
            eventId: event,
            kind: (info[Field.kind] as? String).flatMap(NotificationKind.init(rawValue:)),
            at: (info[Field.at] as? Double).map(Date.init(timeIntervalSince1970:)),
            messageId: (info[Field.message] as? String).flatMap { $0.isEmpty ? nil : $0 },
            turnId: (info[Field.turn] as? String).flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// Anchors resolved after their notification was posted (the capture outlasted the post's short
/// wait), so a click can still find its exact message. Small and capped; ids and times only.
public struct NotificationAnchorLog: Codable, Sendable, Equatable {
    public static let capacity = 64
    public private(set) var entries: [NotificationAnchor] = []

    public init() {}

    public mutating func record(_ anchor: NotificationAnchor) {
        entries.removeAll { $0.eventId == anchor.eventId }
        entries.append(anchor)
        if entries.count > Self.capacity { entries.removeFirst(entries.count - Self.capacity) }
    }

    /// `anchor` with whatever identity the log learned since it was posted.
    public func resolve(_ anchor: NotificationAnchor) -> NotificationAnchor {
        guard let known = entries.last(where: { $0.eventId == anchor.eventId }) else { return anchor }
        var out = anchor
        out.messageId = anchor.messageId ?? known.messageId
        out.turnId = anchor.turnId ?? known.turnId
        out.at = anchor.at ?? known.at
        out.kind = anchor.kind ?? known.kind
        return out
    }
}

public enum ContextConfidence: String, Codable, Sendable, Hashable {
    /// The very message (or turn) the event recorded.
    case exact
    /// No identity was recorded; the newest reply at or before the event's time, with times to prove it.
    case atOrBeforeEvent
    /// The newest reply there is now, and the screen says so.
    case latestAvailable
    /// Nothing trustworthy to show.
    case unavailable
}

/// The reading side of a notification: the reply it was about, the request that prompted it, and
/// the earlier replies of the same turn. Everything is the chat's own text, never a summary.
public struct NotificationContextContent: Sendable, Equatable {
    public var confidence: ContextConfidence
    public var request: ChatMessage?
    /// Earlier assistant messages of the same turn, oldest first.
    public var earlier: [ChatMessage]
    public var response: ChatMessage?
    /// Why this is not the exact message, in plain words. Nil when it is.
    public var note: String?

    public init(
        confidence: ContextConfidence, request: ChatMessage? = nil, earlier: [ChatMessage] = [],
        response: ChatMessage? = nil, note: String? = nil
    ) {
        self.confidence = confidence; self.request = request; self.earlier = earlier
        self.response = response; self.note = note
    }

    public static func unavailable(_ note: String) -> NotificationContextContent {
        NotificationContextContent(confidence: .unavailable, note: note)
    }

    public var hasEarlier: Bool { request != nil || !earlier.isEmpty }

    /// What is worth keeping so this notification still opens on its reply after a relaunch.
    public var cacheable: [ChatMessage] { [request].compactMap { $0 } + earlier + [response].compactMap { $0 } }
}

public enum NotificationContextPolicy {
    /// Timestamps from two sources (the event clock, the transcript) differ by a moment.
    public static let timeTolerance: TimeInterval = 2
    /// A reply this fresh is the newest one even when the transcript has no times to prove it.
    public static let recentWindow: TimeInterval = 120

    private static func blank(_ m: ChatMessage) -> Bool { m.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Host messages only: a message of ours the transcript has not shown yet is not what any event was about.
    private static func hostMessages(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter { !$0.id.hasPrefix("local-") }
    }

    /// A request of the user's, at or before `limit` (or of unknown time), that comes after `index`
    /// and so has no reply in this list: the reply at `index` answers an older request.
    private static func hasUnansweredRequest(_ list: [ChatMessage], after index: Int, limit: Date?) -> Bool {
        list[(index + 1)...].contains { m in
            guard m.role == .user, !blank(m) else { return false }
            guard let limit, let at = m.at else { return true }
            return at <= limit
        }
    }

    /// Pins the reply an event is demonstrably about, taken when the capture runs. A reply that
    /// came after the event (the capture was slow) is passed over; so is one answering an older
    /// request when a newer request of the user's has no reply. A reply with no time is never pinned,
    /// however fresh the capture. With nothing certain it returns the
    /// time-only anchor, and the composer then matches by time or says it can't.
    public static func anchorNow(event: NotificationEvent, messages: [ChatMessage], now: Date = Date()) -> NotificationAnchor? {
        guard var anchor = NotificationAnchor(event: event) else { return nil }
        let list = hostMessages(messages)
        let limit = event.at?.addingTimeInterval(timeTolerance)
        let eligible = list.indices.filter { i in
            let m = list[i]
            guard m.role == .assistant, !blank(m) else { return false }
            // No time, no proof: a fresh capture can still hold a newer, untimed turn. Never pinned.
            guard let at = m.at else { return false }
            return limit.map { at <= $0 } ?? true
        }
        guard let pick = eligible.last, !hasUnansweredRequest(list, after: pick, limit: limit) else { return anchor }
        anchor.messageId = list[pick].id
        anchor.turnId = list[pick].turnId
        return anchor
    }

    /// Picks the reply a notification was about out of a transcript (oldest first). `anchor` is nil
    /// for a plain open of a chat; `fromNotification` with no anchor is a notification posted by an
    /// older Squeak, which can only show the latest and says so.
    public static func resolve(
        messages: [ChatMessage], anchor: NotificationAnchor?, fromNotification: Bool = false, now: Date = Date()
    ) -> NotificationContextContent {
        let list = hostMessages(messages)
        func replies(where match: (ChatMessage) -> Bool) -> [Int] {
            list.indices.filter { list[$0].role == .assistant && !blank(list[$0]) && match(list[$0]) }
        }
        func latest(note: String?) -> NotificationContextContent {
            guard let i = replies(where: { _ in true }).last else {
                return .unavailable("This chat has no reply to show yet.")
            }
            let trailing = list.last { !blank($0) }?.role == .user
                ? "A newer message of yours has no reply yet." : nil
            return content(list, at: i, confidence: .latestAvailable, note: [note, trailing].compactMap { $0 }.joined(separator: " ").nilIfEmpty)
        }
        guard let anchor else {
            return latest(note: fromNotification
                ? "Showing the latest message. This notification came from an older version that didn't record which one it was about."
                : nil)
        }
        if let id = anchor.messageId, let i = replies(where: { $0.id == id }).last {
            return content(list, at: i, confidence: .exact, note: nil)
        }
        if let turn = anchor.turnId, let i = replies(where: { $0.turnId == turn }).last {
            return content(list, at: i, confidence: .exact, note: nil)
        }
        guard let eventAt = anchor.at else {
            return latest(note: "Showing the latest message. This notification didn't record which one it was about.")
        }
        let limit = eventAt.addingTimeInterval(timeTolerance)
        let timed = replies { $0.at != nil }
        let atOrBefore = timed.filter { list[$0].at! <= limit }
        if let best = atOrBefore.max(by: { (list[$0].at!, $0) < (list[$1].at!, $1) }) {
            if hasUnansweredRequest(list, after: best, limit: limit) {
                return .unavailable("The reply for this notification isn't in the chat's history.")
            }
            // An untimed reply after it could just as well be the one this event was about.
            let untimedAfter = replies { $0.at == nil }.contains { $0 > best }
            if !untimedAfter {
                return content(
                    list, at: best, confidence: .atOrBeforeEvent,
                    note: "Matched by time: this notification didn't record which message it was about.")
            }
            return .unavailable("Squeak can't tell which message this notification was about.")
        }
        if timed.isEmpty, now.timeIntervalSince(eventAt) <= recentWindow, !replies(where: { _ in true }).isEmpty {
            return latest(note: "Showing the latest message: the chat's messages have no times to match this notification by.")
        }
        if timed.isEmpty {
            return .unavailable("This chat's messages have no times, so Squeak can't find the one this notification was about.")
        }
        return .unavailable("The message this notification was about is no longer in the chat's history.")
    }

    /// The reply at `index`, the earlier replies of its turn, and the request before them.
    private static func content(_ list: [ChatMessage], at index: Int, confidence: ContextConfidence, note: String?) -> NotificationContextContent {
        let reply = list[index]
        var start = index
        while start > 0, list[start - 1].role == .assistant, sameTurn(list[start - 1], reply) { start -= 1 }
        let earlier = Array(list[start..<index].filter { !blank($0) })
        let request = start > 0 && list[start - 1].role == .user && !blank(list[start - 1]) ? list[start - 1] : nil
        return NotificationContextContent(confidence: confidence, request: request, earlier: earlier, response: reply, note: note)
    }

    private static func sameTurn(_ a: ChatMessage, _ b: ChatMessage) -> Bool {
        guard let x = a.turnId, let y = b.turnId else { return true }
        return x == y
    }

    /// Union of two reads of one chat, one entry per id, the live read winning. No comparator, so
    /// no ordering that pretends missing times are real: a cached message with a time goes before
    /// the first timed message that is later; one without goes right after the cached message that
    /// preceded it in the cache (or first, when nothing it follows is present). Cache-only input
    /// keeps its source order.
    public static func merge(cached: [ChatMessage], live: [ChatMessage]) -> [ChatMessage] {
        var out: [ChatMessage] = []
        var present = Set<String>()
        for m in live where present.insert(m.id).inserted { out.append(m) }
        var previous: String?
        for m in cached {
            if present.contains(m.id) { previous = m.id; continue }
            let index: Int
            if let at = m.at {
                index = out.firstIndex { ($0.at ?? .distantPast) > at } ?? out.count
            } else if let previous, let p = out.firstIndex(where: { $0.id == previous }) {
                index = p + 1
            } else {
                index = 0
            }
            out.insert(m, at: index)
            present.insert(m.id)
            previous = m.id
        }
        return out
    }

    /// A short plain excerpt of a reply for the menu: markdown stripped, one line, cut at a word.
    public static func excerpt(_ text: String, limit: Int = 140) -> String {
        let flat = Choices.stripMarkdown(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > limit else { return flat }
        let cut = String(flat.prefix(limit))
        let head = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut
        return head.trimmingCharacters(in: CharacterSet(charactersIn: " ,.;:-")) + "…"
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// The tiny status line above a notification's context: "Finished · 1m ago".
public struct ContextStatusLine: Sendable, Equatable {
    public enum Symbol: Sendable, Equatable { case finished, error, attention, plan, neutral }
    public var symbol: Symbol
    public var text: String

    public static func make(kind: NotificationKind?) -> ContextStatusLine {
        switch kind {
        case .finished?: ContextStatusLine(symbol: .finished, text: "Finished")
        case .error?: ContextStatusLine(symbol: .error, text: "Hit an error")
        case .question?: ContextStatusLine(symbol: .attention, text: "Asked you something")
        case .plan?: ContextStatusLine(symbol: .plan, text: "Has a plan for you")
        case .blocked?: ContextStatusLine(symbol: .attention, text: "Waiting for you")
        case nil: ContextStatusLine(symbol: .neutral, text: "Latest message")
        }
    }
}

/// A clicked notification: the chat and, when the notification carried one, its event.
public struct PendingNotificationOpen: Sendable, Equatable {
    public var key: SessionKey
    public var anchor: NotificationAnchor?
    /// False only for a plain open of a chat (no notification behind it).
    public var fromNotification: Bool

    public init(key: SessionKey, anchor: NotificationAnchor? = nil, fromNotification: Bool = true) {
        self.key = key; self.anchor = anchor; self.fromNotification = fromNotification
    }
}

public extension NotificationRouting {
    /// Same rules as `sessionToOpen` (a dismissal or a malformed id opens nothing), keeping the event.
    static func openRequest(dismissed: Bool, session: String?, anchor: NotificationAnchor?) -> PendingNotificationOpen? {
        sessionToOpen(dismissed: dismissed, session: session).map { PendingNotificationOpen(key: $0, anchor: anchor) }
    }
}

/// `PendingOpens` for clicks that carry their event: only the latest click matters.
public struct PendingNotificationOpens: Sendable {
    private var pending: PendingNotificationOpen?
    public init() {}

    public mutating func deliver(_ open: PendingNotificationOpen, handlerReady: Bool) -> PendingNotificationOpen? {
        if handlerReady { return open }
        pending = open
        return nil
    }

    public mutating func drain() -> PendingNotificationOpen? {
        defer { pending = nil }
        return pending
    }
}

/// Decides whether a finished load may still touch the composer. A load belongs to the chat and
/// the show it began under; hiding, retargeting or opening another chat invalidates it, so a
/// slow read can never paint one chat's reply over another's.
public struct ContextLoadGate: Sendable, Equatable {
    public struct Token: Sendable, Equatable {
        public var generation: Int
        public var key: SessionKey
        public var eventId: String?
    }

    private var generation = 0
    private var active: Token?

    public init() {}

    public mutating func begin(key: SessionKey, eventId: String?) -> Token {
        generation += 1
        let token = Token(generation: generation, key: key, eventId: eventId)
        active = token
        return token
    }

    public mutating func invalidate() {
        generation += 1
        active = nil
    }

    public func accepts(_ token: Token) -> Bool { active == token }
}

/// Which chats have an update the user has not yet seen, by event. An event stays unread until
/// content that includes it is actually displayed; opening the menu is not that. Ids and times
/// only, so it is safe in defaults.
public struct UnreadTracker: Codable, Sendable, Equatable {
    public struct Entry: Codable, Sendable, Hashable {
        public var id: String
        public var at: Date
    }

    public static let readCapacity = 200
    public static let perChat = 8
    public static let chats = 64

    public private(set) var pending: [String: [Entry]] = [:]
    public private(set) var read: [String] = []

    public init() {}

    /// Records an event as unread. False when it was already read or already pending.
    @discardableResult
    public mutating func note(_ key: SessionKey, id: String, at: Date) -> Bool {
        guard !read.contains(id), !(pending[key.stringValue] ?? []).contains(where: { $0.id == id }) else { return false }
        var list = pending[key.stringValue] ?? []
        list.append(Entry(id: id, at: at))
        if list.count > Self.perChat { list.removeFirst(list.count - Self.perChat) }
        pending[key.stringValue] = list
        if pending.count > Self.chats {
            let oldest = pending.min { ($0.value.last?.at ?? .distantPast) < ($1.value.last?.at ?? .distantPast) }?.key
            if let oldest { pending[oldest] = nil }
        }
        return true
    }

    public func hasUnread(_ key: SessionKey) -> Bool { !(pending[key.stringValue] ?? []).isEmpty }

    /// Reads the events whose time is at or before `through` (what was on screen); nil reads all
    /// of them. An update that arrives later stays unread.
    public mutating func markRead(_ key: SessionKey, through: Date? = nil) {
        guard let list = pending[key.stringValue] else { return }
        let seen = list.filter { through == nil || $0.at <= through! }
        let left = list.filter { e in !seen.contains(e) }
        pending[key.stringValue] = left.isEmpty ? nil : left
        for e in seen { remember(e.id) }
    }

    /// An event read on its own (its reply was shown) whether or not it was pending.
    public mutating func markRead(eventId: String) {
        for (k, list) in pending {
            let left = list.filter { $0.id != eventId }
            if left.count != list.count { pending[k] = left.isEmpty ? nil : left }
        }
        remember(eventId)
    }

    private mutating func remember(_ id: String) {
        guard !read.contains(id) else { return }
        read.append(id)
        if read.count > Self.readCapacity { read.removeFirst(read.count - Self.readCapacity) }
    }
}
