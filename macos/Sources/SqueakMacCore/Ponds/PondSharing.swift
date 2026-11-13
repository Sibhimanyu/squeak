import Foundation

/// Whether a pond is one this person owns or one someone shared with them, and how a badge on its icon says so. The host
/// sends `role` (owner / member / viewer), `local` and `ownerName` on every pond (`PondSummary`); there is no sharer photo
/// in that data, so the badge is the sharer's initials. Pure, so CI pins it.
public enum PondSharing {
    /// The sidebar filter's ownership choice (kept as its raw value across launches).
    public enum Scope: String, Sendable, CaseIterable, Equatable {
        case all, mine, shared
        public var title: String {
            switch self {
            case .all: "All ponds"
            case .mine: "Mine"
            case .shared: "Shared with me"
            }
        }
    }

    /// What the icon's corner badge shows.
    public struct Badge: Sendable, Equatable {
        /// The sharer's initials ("AP"); nil when no name is known, and the badge is a people symbol.
        public var initials: String?
        /// Tooltip and VoiceOver: "Shared with you by Aarav", else "Shared with you".
        public var label: String
    }

    /// True for a pond someone else owns and this person has joined: an active pond, not local, and not owned by them. A
    /// waiting, declined or ended join is not shared yet, and a pond with no pond data (a plain project) is mine.
    public static func isSharedWithMe(_ pond: PondSummary?) -> Bool {
        guard let pond, !pond.local else { return false }
        return pond.state == .active && pond.role != .owner
    }

    /// The sharer's name as shown: trimmed, nil when empty.
    public static func sharerName(_ pond: PondSummary) -> String? {
        let n = pond.ownerName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return n.isEmpty ? nil : n
    }

    /// Up to two letters: the first letters of the first and last words ("Aarav Patel" is "AP"), uppercased.
    public static func initials(_ name: String) -> String? {
        let words = name.split(whereSeparator: { $0.isWhitespace }).filter { $0.first?.isLetter == true || $0.first?.isNumber == true }
        guard let first = words.first?.first else { return nil }
        guard words.count > 1, let last = words.last?.first else { return String(first).uppercased() }
        return (String(first) + String(last)).uppercased()
    }

    /// The badge for a pond, nil for one the person owns.
    public static func badge(for pond: PondSummary?) -> Badge? {
        guard let pond, isSharedWithMe(pond) else { return nil }
        guard let name = sharerName(pond) else { return Badge(initials: nil, label: "Shared with you") }
        return Badge(initials: initials(name), label: "Shared with you by \(name)")
    }

    /// Whether a pond passes the ownership scope.
    public static func matches(_ scope: Scope, shared: Bool) -> Bool {
        switch scope {
        case .all: true
        case .mine: !shared
        case .shared: shared
        }
    }
}
