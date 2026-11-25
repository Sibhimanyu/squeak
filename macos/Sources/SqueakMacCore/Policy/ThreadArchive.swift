import Foundation

/// Archiving an add-on thread: which menu items appear, which chats the lists show, and the archived view's words.
/// Squeak's own chats (Ducks) have no archive: the host moves old archived ones to Off duty, and Off duty and Delete
/// Duck are all a Duck has. Two kinds still archive:
///  - any other thread (Conductor, terminal, Codex, desktop, headless): hidden in Squeak only, by the daemon
///    (`archived-sessions.json`); Conductor's database and the agent's files are never touched;
///  - a thread someone else started in a shared pond: hidden from your view only (`SharedThreadHides`), never theirs.
/// The host and daemon own the rules; this keeps the menu from offering what they would refuse.
public enum ThreadArchive {
    /// Who archives a thread.
    public enum Kind: Sendable, Equatable {
        /// A chat Squeak runs: the session host.
        case squeak
        /// Any other thread on this Mac: the daemon's Squeak-side archive (hide in Squeak only).
        case fleet
    }

    /// A Squeak chat is the host's; every other thread with a key is the daemon's.
    public static func kind(_ s: HostSession) -> Kind? {
        if ThreadTitle.canRename(s) { return .squeak }
        return s.source == .squeak || s.key.hostSessionId.isEmpty ? nil : .fleet
    }

    /// What a context menu offers for a thread.
    public enum MenuItem: Sendable, Equatable { case archive, unarchive }

    /// "Archive" for any thread in the list (a working Squeak chat asks to stop first); "Unarchive" for an archived one;
    /// nothing for a row with no key. One rule for the sidebar, chat tabs, pond rows, Main chats and the Archived page.
    public static func menuItem(_ s: HostSession) -> MenuItem? {
        // Ducks have no archive, only Off duty and Delete Duck: a Squeak chat offers neither Archive nor Unarchive.
        guard kind(s) == .fleet else { return nil }
        if s.archivedAt != nil { return .unarchive }
        return s.state != .working && s.state != .blocked ? .archive : nil
    }

    public static func canArchive(_ s: HostSession) -> Bool { menuItem(s) == .archive }

    public static func canUnarchive(_ s: HostSession) -> Bool { menuItem(s) == .unarchive }

    /// The menu item for a thread someone else started in a shared pond: your own view's hide, never theirs.
    public static func sharedMenuItem(hidden: Bool) -> MenuItem { hidden ? .unarchive : .archive }

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

    /// The pond home's Archived section title: nil when nothing is archived there.
    public static func entryTitle(count: Int) -> String? { count > 0 ? "Archived (\(count))" : nil }

    /// An archived chat opens read-only: "Unarchive" stands where the composer was.
    public static func composerReplaced(_ s: HostSession) -> Bool { s.archivedAt != nil }
    public static let readOnlyNote = "This duck is archived."
}
