import Foundation

/// When a call rings (`hold: { holdAtMac, graceSeconds, awayAfterSeconds, sawItAwayAfterSeconds, maxHoldMinutes }`).
/// The daemon owns the rules and the ranges (`src/voice/settings.ts`); this carries them, clamps what the steppers
/// can reach to the same ranges, and builds the one `hold` change. A daemon without `hold` in its view hides the group.
public struct CallHold: Sendable, Equatable, Decodable {
    public var holdAtMac: Bool
    public var graceSeconds: Int
    public var awayAfterSeconds: Int
    public var sawItAwayAfterSeconds: Int
    public var maxHoldMinutes: Int

    public static let graceRange = 15...600
    public static let awayRange = 30...900
    public static let sawItRange = 30...1800
    public static let maxHoldRange = 1...120

    public static let defaults = CallHold()

    public init(holdAtMac: Bool = true, graceSeconds: Int = 45, awayAfterSeconds: Int = 90,
                sawItAwayAfterSeconds: Int = 180, maxHoldMinutes: Int = 15) {
        self.holdAtMac = holdAtMac
        self.graceSeconds = graceSeconds
        self.awayAfterSeconds = awayAfterSeconds
        self.sawItAwayAfterSeconds = sawItAwayAfterSeconds
        self.maxHoldMinutes = maxHoldMinutes
    }

    private enum Keys: String, CodingKey { case holdAtMac, graceSeconds, awayAfterSeconds, sawItAwayAfterSeconds, maxHoldMinutes }

    /// Any key the daemon leaves out reads as its default; a number outside the range is pulled back into it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let d = CallHold()
        holdAtMac = (try? c.decode(Bool.self, forKey: .holdAtMac)) ?? d.holdAtMac
        graceSeconds = Self.clamp((try? c.decode(Int.self, forKey: .graceSeconds)) ?? d.graceSeconds, Self.graceRange)
        awayAfterSeconds = Self.clamp((try? c.decode(Int.self, forKey: .awayAfterSeconds)) ?? d.awayAfterSeconds, Self.awayRange)
        sawItAwayAfterSeconds = Self.clamp((try? c.decode(Int.self, forKey: .sawItAwayAfterSeconds)) ?? d.sawItAwayAfterSeconds, Self.sawItRange)
        maxHoldMinutes = Self.clamp((try? c.decode(Int.self, forKey: .maxHoldMinutes)) ?? d.maxHoldMinutes, Self.maxHoldRange)
    }

    public static func clamp(_ value: Int, _ range: ClosedRange<Int>) -> Int { min(max(value, range.lowerBound), range.upperBound) }

    /// This value with every number held inside the daemon's ranges.
    public var clamped: CallHold {
        CallHold(holdAtMac: holdAtMac, graceSeconds: Self.clamp(graceSeconds, Self.graceRange),
                 awayAfterSeconds: Self.clamp(awayAfterSeconds, Self.awayRange),
                 sawItAwayAfterSeconds: Self.clamp(sawItAwayAfterSeconds, Self.sawItRange),
                 maxHoldMinutes: Self.clamp(maxHoldMinutes, Self.maxHoldRange))
    }

    /// `{ "hold": { all five keys } }`, integers only, inside the ranges.
    public func requestBody() -> Data {
        let c = clamped
        let inner: [String: Any] = [
            "holdAtMac": c.holdAtMac, "graceSeconds": c.graceSeconds, "awayAfterSeconds": c.awayAfterSeconds,
            "sawItAwayAfterSeconds": c.sawItAwayAfterSeconds, "maxHoldMinutes": c.maxHoldMinutes,
        ]
        return (try? JSONSerialization.data(withJSONObject: ["hold": inner], options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    /// "45 seconds", "3 minutes", "1 min 30 s": how a span of seconds reads next to a stepper.
    public static func span(seconds: Int) -> String {
        if seconds < 60 { return "\(seconds) second\(seconds == 1 ? "" : "s")" }
        let m = seconds / 60, s = seconds % 60
        if s == 0 { return "\(m) minute\(m == 1 ? "" : "s")" }
        return "\(m) min \(s) s"
    }

    public static func minutes(_ n: Int) -> String { "\(n) minute\(n == 1 ? "" : "s")" }

    /// Step sizes that keep every value reachable from the defaults: 15 s, 30 s, 30 s, 1 min.
    public static let graceStep = 15
    public static let awayStep = 30
    public static let sawItStep = 30
    public static let maxHoldStep = 1

    /// The settings that only matter while holding; the view dims them when `holdAtMac` is off.
    public var holdDetailsApply: Bool { holdAtMac }
}
