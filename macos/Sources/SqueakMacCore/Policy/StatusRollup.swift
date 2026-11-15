import Foundation

/// A pond's or stream's status at a glance: the same rollup the daemon decides (`activity` + counts in the phone view
/// and `/state.pondStatus`; needs you, then working, then error, else idle). On the Mac the threads' marks are local
/// and instant, so the app folds them with the identical precedence; the daemon's field is read when marks are absent
/// (another Mac's threads). Surfaces draw it and decide nothing more.
public struct StatusRollup: Equatable, Sendable {
    public var state: StreamGlyphState
    public var working: Int
    public var needsYou: Int

    public init(state: StreamGlyphState, working: Int = 0, needsYou: Int = 0) {
        self.state = state; self.working = working; self.needsYou = needsYou
    }

    /// From threads' marks; a running duckling counts its chat as working.
    public static func of(marks: [ChatMark?], ducklingsRunning: [Int] = []) -> StatusRollup {
        var working = 0, waiting = 0
        for (i, mark) in marks.enumerated() {
            let held = i < ducklingsRunning.count && ducklingsRunning[i] > 0
            if mark?.kind == .waiting { waiting += 1 } else if mark?.kind == .working || held { working += 1 }
        }
        let overall = StreamGlyphState.of(marks: marks, ducklingsRunning: ducklingsRunning.reduce(0, +))
        return StatusRollup(state: overall, working: working, needsYou: waiting)
    }

    /// From the daemon's `activity` word (`working`, `needs_you`, `error`, `idle`); nil for a word this app does not know.
    public static func of(activity: String?, working: Int?, needsYou: Int?) -> StatusRollup? {
        let state: StreamGlyphState
        switch activity {
        case "working": state = .working
        case "needs_you": state = .waiting
        case "error": state = .failed
        case "idle": state = .idle
        default: return nil
        }
        return StatusRollup(state: state, working: working ?? 0, needsYou: needsYou ?? 0)
    }

    /// "greenroom, 1 working, 1 needs you" (VoiceOver and tooltip); just the name when nothing is going on.
    public func label(for name: String) -> String {
        var parts = [name]
        if working > 0 { parts.append("\(working) working") }
        if needsYou > 0 { parts.append("\(needsYou) needs you") }
        if parts.count == 1, state == .failed { parts.append("failed") }
        return parts.joined(separator: ", ")
    }
}

/// What a pond row shows in its trailing slot (the count's place), so the row never changes size.
public enum PondRowMark: Equatable, Sendable {
    case count(Int)
    case working
    case needsYou(Int)
    case error

    /// Needs you (with its count) wins, then working, then error; idle shows the count as before.
    public static func of(_ rollup: StatusRollup, count: Int?) -> PondRowMark? {
        switch rollup.state {
        case .waiting: .needsYou(max(rollup.needsYou, 1))
        case .working: .working
        case .failed: .error
        case .idle, .unread: count.map(PondRowMark.count)
        }
    }
}
