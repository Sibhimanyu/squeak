import Foundation

/// A pond's or stream's status at a glance. The Mac decides it (`activity`, `working`, `needsYou` on a pond and on
/// each of its streams in the phone view; needs you, then working, then error, else idle) and the phone only draws
/// it; an older Mac sends none, so the phone folds the chats it has with the same precedence.
public struct StatusRollup: Equatable, Sendable {
    public enum Activity: String, Sendable { case working, needsYou = "needs_you", error, idle }
    public var activity: Activity
    public var working: Int
    public var needsYou: Int

    public init(activity: Activity, working: Int = 0, needsYou: Int = 0) {
        self.activity = activity; self.working = working; self.needsYou = needsYou
    }

    /// The Mac's own word; nil when absent or one this phone does not know (then it folds the chats).
    public init?(activity: String?, working: Int?, needsYou: Int?) {
        guard let a = activity.flatMap(Activity.init(rawValue:)) else { return nil }
        self.init(activity: a, working: working ?? 0, needsYou: needsYou ?? 0)
    }

    /// The same rule as the daemon's `rollupStatus`: a chat waiting on you, else working (a running duckling counts),
    /// else failed.
    public init(sessions: [PhoneSnapshot.Session]) {
        var working = 0, waiting = 0, failed = 0
        for s in sessions {
            if s.needsYou { waiting += 1 }
            else if s.state == "working" || (s.ducklings?.running ?? 0) > 0 { working += 1 }
            else if s.state == "error" { failed += 1 }
        }
        self.init(activity: waiting > 0 ? .needsYou : working > 0 ? .working : failed > 0 ? .error : .idle,
                  working: working, needsYou: waiting)
    }

    /// "greenroom, 1 working, 1 needs you"; just the name when nothing is going on.
    public func label(for name: String) -> String {
        var parts = [name]
        if working > 0 { parts.append("\(working) working") }
        if needsYou > 0 { parts.append("\(needsYou) needs you") }
        if parts.count == 1, activity == .error { parts.append("failed") }
        return parts.joined(separator: ", ")
    }

    /// What a pond row shows in the count's slot.
    public enum Mark: Equatable, Sendable { case needsYou(Int), working, error }

    /// Needs you (with its count) wins, then working, then error; idle shows nothing here (the row keeps its count).
    public var mark: Mark? {
        switch activity {
        case .needsYou: .needsYou(max(needsYou, 1))
        case .working: .working
        case .error: .error
        case .idle: nil
        }
    }
}

/// The stream glyph (DESIGN.md §8.1, "Stream glyph"): a 3 x 6 grid of dots whose rows sit on three gentle waves.
/// idle: still, dim, `muted`. working: a soft brightness wave runs left to right through the dots in the working
/// colour, one pass per `flowSeconds`. needs you and error: steady, no motion. Reduce Motion holds one frame of the
/// wave. Pure functions of state and the wall clock, so every glyph flows in step and a test pins the numbers. The
/// Mac app draws the identical glyph from the same numbers.
public enum StreamDotGlyph {
    public static let rows = 3
    public static let columns = 6
    public static let flowSeconds = 1.6
    public static let framesPerSecond = 20.0
    public static let idleLevel = 0.45
    public static let troughLevel = 0.3
    public static let waveAmplitude = 0.26
    public static let rowLag = 0.35

    /// A dot's centre in the unit square.
    public static func centre(row: Int, column: Int) -> (x: Double, y: Double) {
        let pitchY = 1.0 / Double(rows)
        let y = (Double(row) + 0.5) * pitchY - waveAmplitude * pitchY * sin(2 * .pi * Double(column) / Double(columns))
        return ((Double(column) + 0.5) / Double(columns), y)
    }

    /// The working wave's strength, `troughLevel`...1, its crest travelling right.
    public static func wave(row: Int, column: Int, time: TimeInterval) -> Double {
        let x = (Double(column) + Double(row) * rowLag) / Double(columns)
        let phase = time.truncatingRemainder(dividingBy: flowSeconds) / flowSeconds
        return troughLevel + (1 - troughLevel) * (0.5 + 0.5 * cos(2 * .pi * (phase - x)))
    }

    /// The dot's opacity in the state colour. `animated` false: Reduce Motion, or the Mac is not answering.
    public static func level(_ activity: StatusRollup.Activity, row: Int, column: Int, time: TimeInterval, animated: Bool) -> Double {
        switch activity {
        case .idle: idleLevel
        case .working: wave(row: row, column: column, time: animated ? time : 0)
        case .needsYou, .error: 1
        }
    }

    public static func flows(_ activity: StatusRollup.Activity) -> Bool { activity == .working }
}
