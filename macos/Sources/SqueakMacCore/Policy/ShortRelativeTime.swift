import Foundation

/// "now" / "2m" / "1h" / "3d" / "2w", then a short date for anything older than ~8 weeks.
public enum ShortRelativeTime {
    public static func format(_ date: Date, now: Date = Date()) -> String {
        let s = now.timeIntervalSince(date)
        if s < 60 { return "now" }  // includes future (clock skew)
        let m = Int(s / 60)
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        let d = h / 24
        if d < 7 { return "\(d)d" }
        let w = d / 7
        if w < 8 { return "\(w)w" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        let sameYear = Calendar.current.component(.year, from: date) == Calendar.current.component(.year, from: now)
        f.dateFormat = sameYear ? "d MMM" : "d MMM yyyy"
        return f.string(from: date)
    }
}
