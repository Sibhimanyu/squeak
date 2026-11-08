import Foundation

/// DESIGN.md §3.3 and §8.1: a list never writes a chat's state, it shows one small mark, and the words live in
/// the tooltip and VoiceOver. This is the whole vocabulary of marks and the one rule for which mark a chat, or a
/// folded project or workspace standing for several chats, shows.
public enum ChatMarkKind: Int, Comparable, Sendable, CaseIterable {
    /// Lower is higher priority: waiting on you, failed, finished and not opened, working.
    case waiting = 0, failed, unread, working

    public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

public enum WaitingKind: Sendable, Equatable {
    case approval, answer, plan

    public var words: String {
        switch self {
        case .approval: "Waiting for your approval"
        case .answer: "Waiting for your answer"
        case .plan: "Plan ready for your review"
        }
    }
}

public struct ChatMark: Equatable, Sendable {
    public var kind: ChatMarkKind
    /// Only for `.waiting`: which of the three sentences.
    public var waiting: WaitingKind?

    public init(_ kind: ChatMarkKind, waiting: WaitingKind? = nil) {
        self.kind = kind
        self.waiting = kind == .waiting ? (waiting ?? .answer) : nil
    }

    /// The tooltip and VoiceOver words (exact, §3.3).
    public var words: String {
        switch kind {
        case .waiting: (waiting ?? .answer).words
        case .failed: "Failed"
        case .unread: "Finished, not opened yet"
        case .working: "Working"
        }
    }

    /// The mark a chat shows, or nil (the age shows): finished and read, idle, or not alive.
    /// `unread` is the person's own record (`ChatSeenLog`), not the daemon's.
    public static func of(_ s: HostSession, unread: Bool, now: Date = Date()) -> ChatMark? {
        switch s.state {
        case .blocked where s.alive != false: return ChatMark(.waiting, waiting: waitingKind(s))
        case .working where s.alive != false: return ChatMark(.working)
        case .error where SessionGrouping.isRecent(s, now: now): return ChatMark(.failed)
        case .finished where unread: return ChatMark(.unread)
        default: return nil
        }
    }

    public static func waitingKind(_ s: HostSession) -> WaitingKind {
        if s.awaitingApproval == true { return .approval }
        if s.pendingQuestion == PendingQuestion.planDetail { return .plan }
        return .answer
    }

    /// The words for a folded row's mark: the same sentence, plus the count when several chats share it.
    public static func words(for mark: ChatMark, count: Int) -> String {
        count > 1 ? "\(mark.words), \(count) chats" : mark.words
    }
}

/// What a folded project or workspace shows: the highest-priority mark inside, and how many chats carry it.
public struct FoldedMark: Equatable, Sendable {
    public var mark: ChatMark
    public var count: Int
    public var words: String { ChatMark.words(for: mark, count: count) }

    public init(mark: ChatMark, count: Int) {
        self.mark = mark
        self.count = count
    }

    /// Waiting > failed > unread > working. Of several waiting chats the first by `marks` order names the kind.
    public static func top(_ marks: [ChatMark]) -> FoldedMark? {
        guard let best = marks.min(by: { $0.kind < $1.kind }) else { return nil }
        let same = marks.filter { $0.kind == best.kind }
        // Mixed approval/answer/plan inside one count read as the generic waiting sentence's first member.
        return FoldedMark(mark: best, count: same.count)
    }

    public static func combine(_ parts: [FoldedMark]) -> FoldedMark? {
        guard let best = parts.map(\.mark).min(by: { $0.kind < $1.kind }) else { return nil }
        let count = parts.filter { $0.mark.kind == best.kind }.reduce(0) { $0 + $1.count }
        return FoldedMark(mark: best, count: count)
    }
}

/// Which finished chats the person has opened on this Mac. A chat is unread from a finished turn until it is
/// opened; the record is the turn's end time, so a newer finish makes it unread again. Stored locally
/// (`AppModel`), never sent anywhere. Chats whose turn ended before the log was first made count as read, so an
/// update does not light every recent chat blue.
public struct ChatSeenLog: Codable, Sendable, Equatable {
    public static let capacity = 400

    /// Session key to the turn-end time that was opened.
    public private(set) var seen: [String: Date]
    /// Turns that ended at or before this were already there when the log began.
    public private(set) var baseline: Date?

    public init(baseline: Date? = nil) {
        self.seen = [:]
        self.baseline = baseline
    }

    /// Turn-end time of a finished chat: its last activity.
    static func turnEnd(_ s: HostSession) -> Date? { s.state == .finished ? s.lastActivityAt : nil }

    public func isUnread(_ s: HostSession, now: Date = Date()) -> Bool {
        guard let end = Self.turnEnd(s), SessionGrouping.isRecent(s, now: now) else { return false }
        if let at = seen[s.key.stringValue] { return end > at }
        if let baseline, end <= baseline { return false }
        return true
    }

    /// Opening a chat: reads the turn that has ended now (or earlier ones).
    public mutating func markOpened(_ s: HostSession, now: Date = Date()) {
        let k = s.key.stringValue
        let end = Self.turnEnd(s) ?? now
        guard (seen[k] ?? .distantPast) < end else { return }
        seen[k] = end
        if seen.count > Self.capacity, let oldest = seen.min(by: { $0.value < $1.value })?.key { seen[oldest] = nil }
    }
}
