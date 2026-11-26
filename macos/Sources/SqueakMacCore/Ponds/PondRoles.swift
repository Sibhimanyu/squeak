import Foundation

/// The People page's controls (docs/ponds.md, "Who can do what"). Roles are Owner, Member and Viewer; the Owner changes
/// them from People, and a Member has one switch, Can start Tasks, off by default. The host holds the truth and enforces
/// it on every command; these only name it.
public enum PondRoles {
    public static let startTasksTitle = "Can start Tasks"
    public static let startTasksNote = "Off, their Tasks and new Ducks wait for your approval."

    /// Whether the switch is drawn for `m`: only the Owner sees it, and only for another Member.
    public static func offersStartTasks(_ m: FlockMember, viewerIsOwner: Bool) -> Bool {
        viewerIsOwner && m.role == .member && !m.you
    }
}

/// "Powered by Aarav\u{2019}s MacBook \u{00B7} Flotilla": the mark on a thread a member runs with their own agent on their own Mac.
public enum PondPoweredBy {
    public static func line(nest: String?) -> String {
        let n = nest?.trimmingCharacters(in: .whitespaces) ?? ""
        return n.isEmpty ? "Powered by their Mac \u{00B7} Flotilla" : "Powered by \(n) \u{00B7} Flotilla"
    }
}
