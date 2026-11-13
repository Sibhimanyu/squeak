import Foundation

/// DESIGN.md §3.3 and §8.1: a list never writes a chat's state, it shows one small mark, and the words live in
/// the tooltip and VoiceOver (DESIGN.md §3.3 v3: glyphs, one dot). This is the whole vocabulary of marks and the one rule for which mark a chat, or a
/// folded project or workspace standing for several chats, shows.
public enum ChatMarkKind: Int, Comparable, Sendable, CaseIterable {
    /// Lower is higher priority: waiting on you, failed, finished and not opened, working.
    case waiting = 0, failed, unread, working

    public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

public enum WaitingKind: Sendable, Equatable {
    case approval, answer, plan, looping

    public var words: String {
        switch self {
        case .approval: "Waiting for your approval"
        case .answer: "Waiting for your answer"
        case .plan: "Plan ready for your review"
        case .looping: "Repeating a failing step"
        }
    }
}

public struct ChatMark: Equatable, Sendable {
    public var kind: ChatMarkKind
    /// Only for `.waiting`: which of the three sentences.
    public var waiting: WaitingKind?
    /// Only for `.working`: the chat's own turn ended and background tasks run (the quiet loader, §8.1).
    public var quiet: Bool

    public init(_ kind: ChatMarkKind, waiting: WaitingKind? = nil, quiet: Bool = false) {
        self.kind = kind
        self.waiting = kind == .waiting ? (waiting ?? .answer) : nil
        self.quiet = kind == .working && quiet
    }

    /// The tooltip and VoiceOver words (exact, §3.3).
    public var words: String {
        switch kind {
        case .waiting: (waiting ?? .answer).words
        case .failed: "Failed"
        case .unread: "Finished, not opened yet"
        case .working: quiet ? "Waiting for background tasks" : "Working"
        }
    }

    /// The mark a chat shows, or nil (the age shows): finished and read, idle, or not alive.
    /// `unread` is the person's own record (`ChatSeenLog`), not the daemon's.
    public static func of(_ s: HostSession, unread: Bool, now: Date = Date()) -> ChatMark? {
        if s.isLoopingNow { return ChatMark(.waiting, waiting: .looping) }
        switch s.state {
        case .blocked where s.alive != false: return ChatMark(.waiting, waiting: waitingKind(s))
        case .working where s.alive != false: return ChatMark(.working, quiet: s.backgroundWaiting == true)
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
        guard let top = marks.min(by: { $0.kind < $1.kind }) else { return nil }
        let same = marks.filter { $0.kind == top.kind }
        let best = same.first { !$0.quiet } ?? top
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

    /// "Mark as unread": the finished turn counts as not yet opened again. Only a finished chat has a turn to mark.
    public mutating func markUnread(_ s: HostSession) {
        guard let end = Self.turnEnd(s) else { return }
        seen[s.key.stringValue] = end.addingTimeInterval(-1)
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

/// DESIGN.md §8.1: the loader's frames, the 3x3 dot-grid comet. Nine frames; the dot at column-major index `i`
/// is lit by how far the comet's head has moved past it. Pure, so a test pins the sequence the view draws.
public enum DotGridFrames {
    public static let frameCount = 9
    /// 110 ms a frame (about a second a turn); the quiet loader takes 3 s a turn.
    public static let frameSeconds = 0.110
    public static let quietFrameSeconds = 3.0 / 9
    public static let quietOpacity = 0.7
    /// The frame Reduce Motion holds: the fifth (index 4), whose comet is visible.
    public static let heldFrame = 4
    /// Dot centres and radius on the 14-unit grid the mock was drawn on.
    public static let centres: [Double] = [2.5, 7, 11.5]
    public static let radius = 1.55
    public static let unlit = 0.2

    /// The opacity of each of the nine dots (column by column, top to bottom) in `frame`.
    public static func opacities(frame: Int) -> [Double] {
        let f = ((frame % frameCount) + frameCount) % frameCount
        return (0..<9).map { i in
            let d = (f - i + 9) % 9
            return d <= 3 ? [1, 0.75, 0.5, 0.32][d] : unlit
        }
    }

    /// The frame showing at `time` (seconds, any shared origin: every loader on screen turns in step).
    public static func frame(at time: Double, quiet: Bool) -> Int {
        let step = quiet ? quietFrameSeconds : frameSeconds
        return Int((time / step).rounded(.down)) % frameCount
    }
}
