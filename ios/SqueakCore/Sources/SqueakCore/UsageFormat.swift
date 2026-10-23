import Foundation

/// How a plan reading is worded, kept apart from any view so it can be tested.
/// A reading is only as true as its age: an old one says so, and a window
/// that has reset since is never presented as current.
public enum UsageFormat {
    /// A reading older than this carries its age ("as of 3 hours ago").
    public static let staleAfter: TimeInterval = 60 * 60

    public static func date(_ iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    /// "42% used", rounded to whole percents.
    public static func used(_ percent: Double) -> String { "\(Int(percent.rounded()))% used" }

    /// "resets in 2h 10m", "resets in 5d 3h", or a plain note once the reset has passed.
    public static func resets(_ iso: String, now: Date = Date()) -> String {
        guard let at = date(iso) else { return "" }
        let seconds = at.timeIntervalSince(now)
        if seconds <= 0 { return "has reset since" }
        let minutes = Int((seconds / 60).rounded(.up))
        if minutes < 60 { return "resets in \(minutes)m" }
        let hours = minutes / 60
        if hours < 24 {
            let rest = minutes % 60
            return rest == 0 ? "resets in \(hours)h" : "resets in \(hours)h \(rest)m"
        }
        let days = hours / 24
        let restHours = hours % 24
        return restHours == 0 ? "resets in \(days)d" : "resets in \(days)d \(restHours)h"
    }

    /// "as of 3 hours ago" for a reading older than an hour; nil for a fresh one.
    public static func asOf(_ iso: String, now: Date = Date()) -> String? {
        guard let at = date(iso) else { return nil }
        let seconds = now.timeIntervalSince(at)
        guard seconds >= staleAfter else { return nil }
        let minutes = Int(seconds / 60)
        let hours = minutes / 60
        func unit(_ n: Int, _ word: String) -> String { "as of \(n) \(word)\(n == 1 ? "" : "s") ago" }
        return hours < 24 ? unit(hours, "hour") : unit(hours / 24, "day")
    }

    /// 0...1 for drawing a bar; anything outside is clamped.
    public static func fraction(_ percent: Double) -> Double { min(max(percent / 100, 0), 1) }

    /// Whether the window has reset since this reading was taken.
    public static func hasReset(_ iso: String, now: Date = Date()) -> Bool {
        guard let at = date(iso) else { return false }
        return at <= now
    }

    /// "42% used", or "Reset" once the window has started over. The bars show what is used and
    /// fill as you use it: empty at the start of a window (owner's decision, 2026-10-23,
    /// reversing 2026-10-19, when they showed what was left).
    public static func usedLabel(_ percent: Double, resetsAt: String, now: Date = Date()) -> String {
        hasReset(resetsAt, now: now) ? "Reset" : used(min(max(percent, 0), 100))
    }

    /// The bar for a reading: how much of the window is used, empty once it has reset.
    public static func usedFraction(_ percent: Double, resetsAt: String, now: Date = Date()) -> Double {
        hasReset(resetsAt, now: now) ? 0 : fraction(percent)
    }
}
