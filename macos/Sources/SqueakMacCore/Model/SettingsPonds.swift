import Foundation

/// Settings › Ponds: the list (newest activity first, the recent-on-top rule) and which pond's page is selected.
/// A deep link ("Pond settings…") is a section plus a pond key.
public struct SettingsRoute: Sendable, Equatable {
    public var section: SettingsSection
    public var pond: String?
    public init(section: SettingsSection, pond: String? = nil) { self.section = section; self.pond = pond }
    /// Settings on Ponds, with this pond selected.
    public static func pond(_ key: String) -> SettingsRoute { SettingsRoute(section: .ponds, pond: key) }
}

public enum SettingsPonds {
    /// Newest activity first; ponds with no activity after those that have some; ties by name then id.
    public static func ordered(_ ponds: [PondDirectory.Pond]) -> [PondDirectory.Pond] {
        func at(_ p: PondDirectory.Pond) -> Date? { p.lastActivityAt.flatMap(parse) }
        return ponds.sorted { a, b in
            switch (at(a), at(b)) {
            case let (x?, y?) where x != y: return x > y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (a.name.lowercased(), a.id) < (b.name.lowercased(), b.id)
            }
        }
    }

    /// The pond shown: the requested one while it exists, else the first of the list, else none.
    public static func selection(requested: String?, in ordered: [PondDirectory.Pond]) -> String? {
        if let requested, ordered.contains(where: { $0.id == requested }) { return requested }
        return ordered.first?.id
    }

    private static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
