import Foundation

/// Everything the screens read from the open chat's timeline, made in one place from the reducer's state, so what a
/// refresh changes can be compared (and tested) without a window: the rows by turn, the messages the dock and footers
/// read, each turn's steps, the current turn's steps and the paging state.
public struct TimelinePresentation: Equatable, Sendable {
    public var messages: [ChatMessage]
    public var turnWork: [String: [ActivityStep]]
    public var activity: [ActivityStep]
    /// Each turn's body by the turn's row id.
    public var segments: [String: [TimelineSegment]]
    public var rowIds: [String]
    public var paging: EarlierPaging

    public init(
        _ t: TurnTimeline, details: [String: ToolDetail] = [:], now: Date, me: String? = nil, olderLoading: Bool = false,
        olderError: String? = nil, ready: Bool = true
    ) {
        messages = t.messages(me: me)
        turnWork = TimelineSteps.work(t.turns, details: details)
        let current = t.current ?? t.turns.last
        activity = current.map { TimelineSteps.activity(of: $0, now: now, details: details) } ?? []
        segments = Dictionary(t.turns.map { ($0.id, TimelineSteps.segments(of: $0, details: details)) }, uniquingKeysWith: { a, _ in a })
        rowIds = t.turns.map(\.id)
        paging = EarlierPaging(reachedStart: !t.hasEarlier, loading: olderLoading, error: olderError, known: ready || !t.turns.isEmpty)
    }

    /// The turn rows whose drawing differs from `old`'s: nothing for a refresh that brought nothing new.
    public func changedRows(from old: TimelinePresentation) -> Set<String> {
        var out: Set<String> = []
        for id in rowIds where old.segments[id] != segments[id] { out.insert(id) }
        let oldPrompts = Dictionary(old.messages.filter { $0.role == .user }.map { ($0.turnId ?? $0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for m in messages where m.role == .user {
            if let was = oldPrompts[m.turnId ?? m.id], was != m { out.insert(m.turnId ?? m.id) }
        }
        return out
    }
}

/// A command output shows its first lines and offers the rest, as a diff does.
public enum OutputCap {
    public static let limit = 12
    public static func visible(_ lines: [String], showAll: Bool) -> (lines: [String], hidden: Int) {
        if showAll || lines.count <= limit { return (lines, 0) }
        return (Array(lines.prefix(limit)), lines.count - limit)
    }
}
