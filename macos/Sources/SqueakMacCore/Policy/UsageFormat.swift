import Foundation

/// How a reading is worded, apart from any view so it can be tested. A reading is only as true as
/// its age: an old one says so, and a window that has reset since is never shown as current.
public enum UsageFormat {
    /// A reading older than this carries its age ("as of 3 hours ago").
    public static let staleAfter: TimeInterval = 60 * 60

    /// "42% used", whole percents.
    public static func used(_ percent: Double) -> String { "\(Int(percent.rounded()))% used" }

    /// "resets in 2h 10m", "resets in 5d 3h", or "has reset since" once the time has passed.
    public static func resets(_ at: Date?, now: Date = Date()) -> String {
        guard let at else { return "" }
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

    /// "as of 3 hours ago" for a reading older than an hour; nil while it is fresh or undated.
    public static func asOf(_ observed: Date?, now: Date = Date()) -> String? {
        guard let observed else { return nil }
        let seconds = now.timeIntervalSince(observed)
        guard seconds >= staleAfter else { return nil }
        let hours = Int(seconds / 3600)
        func unit(_ n: Int, _ word: String) -> String { "as of \(n) \(word)\(n == 1 ? "" : "s") ago" }
        return hours < 24 ? unit(hours, "hour") : unit(hours / 24, "day")
    }

    /// 0...1 for a bar.
    public static func fraction(_ percent: Double) -> Double { min(max(percent / 100, 0), 1) }

    /// Whether the window has reset since this reading was taken.
    public static func hasReset(_ at: Date?, now: Date = Date()) -> Bool {
        guard let at else { return false }
        return at <= now
    }

    /// "58% left", or "Reset" once the window has started over. The bars show what is left, like
    /// a battery (owner's decision, 2026-10-19): full when there is plenty, short as it runs out.
    public static func left(_ percent: Double, resetsAt: Date?, now: Date = Date()) -> String {
        hasReset(resetsAt, now: now) ? "Reset" : "\(Int((100 - min(max(percent, 0), 100)).rounded()))% left"
    }

    /// The bar for a reading: what is left of the window, full once it has reset.
    public static func remaining(_ percent: Double, resetsAt: Date?, now: Date = Date()) -> Double {
        hasReset(resetsAt, now: now) ? 1 : 1 - fraction(percent)
    }

    /// "$1.84", or "<$0.01" for a sliver, with no more precision than an estimate deserves.
    public static func dollars(_ usd: Double) -> String {
        if usd > 0, usd < 0.01 { return "<$0.01" }
        return usd.formatted(.currency(code: "USD").precision(.fractionLength(2)))
    }

    /// Sessions' estimated cost for the calendar day of `now`: the sum and how many sessions
    /// had a price. Sessions with no price (a model missing from the table) are left out, never guessed.
    public static func cost(of sessions: [(lastActivityAt: Date?, costUsd: Double?)], now: Date = Date(), calendar: Calendar = .current)
        -> (usd: Double, sessions: Int)
    {
        var total = 0.0
        var count = 0
        for s in sessions {
            guard let at = s.lastActivityAt, let cost = s.costUsd, calendar.isDate(at, inSameDayAs: now) else { continue }
            total += cost
            count += 1
        }
        return (total, count)
    }
}
