import Foundation

/// What a stream's waves icon says (DESIGN.md §3.3: state colours; the duck's yellow is never a state). Derived here,
/// from the daemon's and host's data only: the surfaces draw it and decide nothing.
public enum StreamGlyphState: Equatable, Sendable {
    case idle, working, waiting, failed, unread

    /// Waiting on you wins, then anything working (a duckling running counts), then a failed last turn, then a
    /// finished turn not yet opened; else idle. `ducklingsRunning` is the count of background helpers still running.
    public static func of(marks: [ChatMark?], ducklingsRunning: Int = 0) -> StreamGlyphState {
        let kinds = Set(marks.compactMap { $0?.kind })
        if kinds.contains(.waiting) { return .waiting }
        if kinds.contains(.working) || ducklingsRunning > 0 { return .working }
        if kinds.contains(.failed) { return .failed }
        if kinds.contains(.unread) { return .unread }
        return .idle
    }

    /// A stream's chats on this Mac, marks as the sidebar shows them.
    public static func of(chats: [HostSession], mark: (HostSession) -> ChatMark?) -> StreamGlyphState {
        of(marks: chats.map(mark), ducklingsRunning: chats.reduce(0) { $0 + ($1.ducklings?.running ?? 0) })
    }

    /// A pond card's threads: this Mac's by their mark, another Mac's by the state its host reported.
    public static func of(rows: [PondChatRow]) -> StreamGlyphState {
        let marks: [ChatMark?] = rows.map { row in
            if let m = row.mark { return m }
            guard row.local == nil else { return nil }
            switch row.state {
            case .needsYou: return ChatMark(.waiting)
            case .working: return ChatMark(.working)
            case .failed: return ChatMark(.failed)
            case .finished: return nil
            }
        }
        return of(marks: marks, ducklingsRunning: rows.reduce(0) { $0 + $1.ducklingsRunning })
    }

    /// The word VoiceOver and tooltips add after the stream's name; nil when there is nothing to say.
    public var words: String? {
        switch self {
        case .idle: nil
        case .working: "working"
        case .waiting: "waiting on you"
        case .failed: "failed"
        case .unread: "finished, not opened yet"
        }
    }

    /// "Hong Kong, working".
    public func label(for name: String) -> String { [name, words].compactMap { $0 }.joined(separator: ", ") }
}

/// The waves, as points on Lucide's 24 grid: three lines at y 6, 12 and 18 from x 2 to 22, a sine of amplitude 1 and
/// period 10, which at phase 0 is Lucide `waves` itself (trough at x 4.5, crest at 9.5). `phase` slides the wave
/// along the line; the line's ends stay put, so the icon keeps its size. Pure, so a test pins the geometry.
public enum StreamGlyphGeometry {
    public static let rows: [Double] = [6, 12, 18]
    public static let left = 2.0, right = 22.0, period = 10.0, amplitude = 1.0
    public static let step = 0.5
    /// Seconds a wave takes to travel one period: linear, a loop, not a curve (DESIGN.md §7 bans raw curves only).
    public static let cycleSeconds = 2.0
    /// The most the glyph ticks a second while it flows.
    public static let framesPerSecond = 30.0

    public static func y(row: Int, x: Double, phase: Double) -> Double {
        rows[row] + amplitude * sin(2 * .pi * (x - left) / period + phase)
    }

    public static func points(row: Int, phase: Double) -> [CGPoint] {
        stride(from: left, through: right, by: step).map { CGPoint(x: $0, y: y(row: row, x: $0, phase: phase)) }
    }

    /// The flow's phase at a wall-clock time: travels right, one period per `cycleSeconds`, the same for every glyph
    /// on screen so they turn in step without sharing any state.
    public static func phase(at time: TimeInterval) -> Double {
        let t = time.truncatingRemainder(dividingBy: cycleSeconds) / cycleSeconds
        return -2 * .pi * t
    }
}
