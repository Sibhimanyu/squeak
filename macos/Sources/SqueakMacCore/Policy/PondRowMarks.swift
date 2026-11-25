import Foundation

// The new layout's Pond row (DESIGN.md "New layout"): a colour tile with the Pond's initial, a count badge for chats not
// opened yet, and the amber triangle when something waits on the person. No coloured state dots (DESIGN.md 3.3).

public struct PondRowMarks: Equatable, Sendable {
    /// The amber needs-you triangle.
    public var needsYou: Bool
    /// The unread count shown in the duck-yellow badge; nil when there is nothing unread.
    public var badge: Int?

    /// "9", "99+": the badge's words.
    public var badgeText: String? { badge.map { $0 > 99 ? "99+" : String($0) } }

    public static func of(needsYou: Int, unread: Int) -> PondRowMarks {
        PondRowMarks(needsYou: needsYou > 0, badge: unread > 0 ? unread : nil)
    }
}
