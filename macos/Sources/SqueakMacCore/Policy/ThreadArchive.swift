import Foundation

/// Archiving a thread (a Squeak chat only, like renaming): which menu items appear, which chats the lists show, and
/// the archived view's words. The host owns the rule (refused while the chat works or waits); this keeps the menu
/// from offering what it will refuse.
public enum ThreadArchive {
    public static let busySentence = "Stop the chat before archiving it."

    /// "Archive" appears for a Squeak chat in the list that is not working or waiting on the person.
    public static func canArchive(_ s: HostSession) -> Bool {
        ThreadTitle.canRename(s) && s.archivedAt == nil && s.state != .working && s.state != .blocked
    }

    /// "Unarchive" appears for an archived Squeak chat.
    public static func canUnarchive(_ s: HostSession) -> Bool { ThreadTitle.canRename(s) && s.archivedAt != nil }

    public static func isArchived(_ s: HostSession) -> Bool { s.archivedAt != nil }

    /// The chats every list shows: archived ones leave the sidebar, Dashboard, board, Needs you, menu-bar panel.
    public static func listed(_ sessions: [HostSession]) -> [HostSession] { sessions.filter { $0.archivedAt == nil } }

    /// Archived chats, newest archived first (ties by title, so the order is stable).
    public static func archived(_ sessions: [HostSession]) -> [HostSession] {
        sessions.filter { $0.archivedAt != nil }.sorted {
            let a = $0.archivedAt ?? .distantPast, b = $1.archivedAt ?? .distantPast
            return a != b ? a > b : $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
        }
    }

    /// The archived chats of one pond (project name), by the repo name the sidebar groups on.
    public static func archived(_ sessions: [HostSession], inProject project: String) -> [HostSession] {
        archived(sessions).filter { $0.repoName?.lowercased() == project.lowercased() }
    }

    /// The row at the foot of a pond's thread list: nil when nothing is archived there.
    public static func entryTitle(count: Int) -> String? { count > 0 ? "Archived (\(count))" : nil }

    /// An archived chat opens read-only: "Unarchive" stands where the composer was.
    public static func composerReplaced(_ s: HostSession) -> Bool { s.archivedAt != nil }
    public static let readOnlyNote = "This thread is archived."
}
