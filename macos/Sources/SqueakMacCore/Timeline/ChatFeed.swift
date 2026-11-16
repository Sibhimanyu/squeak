import Foundation

/// Everything a Squeak chat's transcript draws, in drawing order, from one place. The view only lays this out; it
/// decides nothing. The rules that keep the chat still while it updates:
///
///  - **One row per message.** A message is in exactly one place: a prompt (sent, sending or queued) is its turn's row;
///    a steer is a step of the turn it went into, dimmed until the agent takes it in; the text being written is the
///    running turn's last row, and the finished message takes that same place.
///  - **Rows never move.** A row, once drawn, keeps its id and its place; later rows only appear after it or, for a
///    turn the host started that this Mac never pressed, above the presses still waiting for the host.
///  - **Nothing flickers.** A row is never dropped and drawn again; data that arrives twice, late or out of order
///    changes nothing (`TurnTimeline` is idempotent by seq).
public struct ChatFeed: Equatable, Sendable {
    public var turns: [TimelineTurn]
    /// Steer steps the agent has not taken in yet: drawn dimmed, in their place.
    public var waitingSteers: Set<String>
    /// Steers the host holds that are not a step of any turn held here (an older host): drawn dimmed after the turns.
    public var looseSteers: [NativePendingStack.Card]
    /// The turn whose last row is the text being written (the running one).
    public var streamingTurn: String?

    public init(_ timeline: TurnTimeline, pending: NativePendingStack = NativePendingStack()) {
        turns = timeline.turns
        let steering = pending.host.filter { $0.state == .steering }
        var waiting: Set<String> = []
        // Not read by the agent yet: our own press the host has not named, or a host step that says so ("running").
        // Only the steps say it, never the pending cards beside them, so a steer cannot dim, light and dim again as
        // two streams arrive in either order. (An older host's steps are always done: drawn solid, once.)
        for turn in turns.suffix(6) {
            for step in turn.steps where step.kind == .steer && step.status == .running { waiting.insert(step.id) }
        }
        waitingSteers = waiting
        // A steer the host names by its row (seq) is always a step of the running turn, held here: never drawn twice.
        // Only one with no row (a runner that is interrupted to take it) is drawn on its own, unless its words are
        // already a press or a waiting step here.
        let openWords = Set(turns.filter { $0.turnId == nil }.map(\.prompt))
        let waitingWords = Set(turns.suffix(6).flatMap { t in t.steps.filter { waiting.contains($0.id) }.map { $0.detail["text"]?.string ?? $0.label } })
        looseSteers = steering.filter { $0.seq == nil && !openWords.contains($0.text) && !waitingWords.contains($0.text) }.map { item in
            NativePendingStack.Card(id: item.id, text: item.text, kind: .steering, held: item.held, isLocal: false,
                                    waitingForHelper: item.waitingForHelper, helper: item.helper, canSendNow: item.canSendNow)
        }
        streamingTurn = turns.last(where: { $0.state == .running })?.id
    }

    /// How a prompt row is drawn.
    public enum PromptStyle: Equatable, Sendable {
        /// A bubble (dimmed while sending).
        case bubble
        /// The queue's one line: waiting behind the running turn.
        case queuedLine
        /// No prompt: the agent began the turn itself.
        case none
    }

    public static func promptStyle(_ t: TimelineTurn) -> PromptStyle {
        if t.auto { return .none }
        if t.waitsInQueue { return .queuedLine }
        if t.turnId == nil, t.state == .sending, t.behindTurn { return .queuedLine }
        return .bubble
    }

    /// Every row's id in drawing order: what the screen shows, for the tests that hold the rules above.
    public func rowIds(details: [String: ToolDetail] = [:], streaming: Bool = false) -> [String] {
        var out: [String] = []
        for t in turns {
            switch Self.promptStyle(t) {
            case .bubble: out.append("prompt:\(t.id)")
            case .queuedLine: out.append("queued:\(t.id)")
            case .none: break
            }
            for seg in TimelineSteps.segments(of: t, details: details) {
                if case .steer = seg, waitingSteers.contains(seg.id) { out.append("steer-waiting:\(seg.id)") } else { out.append(seg.id) }
            }
            if streaming, t.id == streamingTurn, t.streaming != nil { out.append("streaming:\(t.id)") }
        }
        out += looseSteers.map { "loose:\($0.id)" }
        return out
    }
}
