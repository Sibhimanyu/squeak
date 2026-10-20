import Foundation

/// Conductor writes timestamps two ways. The app writes ISO-8601 with an
/// offset (`2026-09-22T03:01:12.257Z`); its `update_sessions_updated_at`
/// trigger rewrites `updated_at` with `datetime('now')`, a UTC wall time with
/// no offset (`2026-09-22 04:11:37`). Reading the second in local time makes
/// every trigger-touched row look hours stale on a non-UTC machine.
public enum ConductorTime {
    /// Naive `YYYY-MM-DD HH:MM[:SS[.fff]]` becomes `...T...Z`; anything else passes through.
    public static func toIso(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return value }
        let trimmed = value.trimmingCharacters(in: .whitespaces)
        let pattern = #"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)),
              let d = Range(match.range(at: 1), in: trimmed), let t = Range(match.range(at: 2), in: trimmed)
        else { return value }
        return "\(trimmed[d])T\(trimmed[t])Z"
    }

    /// Parses either spelling (and plain ISO from transcripts) to a Date.
    public static func date(_ value: String?) -> Date? {
        guard let iso = toIso(value) else { return nil }
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = withFraction.date(from: iso) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let d = plain.date(from: iso) { return d }
        // `YYYY-MM-DDTHH:MM` with no seconds or zone: Conductor's naive minute form, as UTC.
        let loose = ISO8601DateFormatter()
        loose.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime, .withTimeZone]
        return loose.date(from: iso)
    }
}
