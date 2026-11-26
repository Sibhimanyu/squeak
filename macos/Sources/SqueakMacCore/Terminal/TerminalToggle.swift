import Foundation

/// ⌘J, the Terminal icon on the work pane's rail and the command palette's "Toggle terminal" are one decision: which page
/// is on screen, whether its terminal is showing, and which folder it runs in. Pure, so the three entrances cannot drift.
public enum TerminalToggle {
    /// The page that holds the work pane (the new layout), with what the folder is made of.
    public enum Page: Equatable, Sendable {
        /// An open Duck's chat: its own folder, else the Pond's.
        case duck(paneKey: String, cwd: String?, pondFolder: String?)
        /// The Pond's Dashboard, Room or New duck page: the Pond's own folder.
        case pond(paneKey: String, folder: String?)
        /// Not a page with a work pane (the classic layout, Settings, the global Dashboard): the old dock decides.
        case none
    }

    public enum Decision: Equatable, Sendable {
        /// The pane is showing for this page: close it.
        case close
        /// Open the pane for this page; `folder` is nil when no folder exists on this Mac (the pane says so, never nothing).
        case open(paneKey: String, folder: String?)
        /// Not a work-pane page.
        case classic
    }

    /// `shownFor` is the page key the pane is open for now (nil while it is closed).
    public static func decide(page: Page, shownFor: String?, isDirectory: (String) -> Bool = TerminalWorkspace.isDirectoryOnDisk) -> Decision {
        switch page {
        case .none:
            return .classic
        case .duck(let key, _, _), .pond(let key, _):
            if shownFor == key { return .close }
            return .open(paneKey: key, folder: folder(page: page, isDirectory: isDirectory))
        }
    }

    /// The folder the page's shell runs in: the Duck's, else the Pond's; the Pond's alone on a Pond page.
    public static func folder(page: Page, isDirectory: (String) -> Bool = TerminalWorkspace.isDirectoryOnDisk) -> String? {
        switch page {
        case .none: return nil
        case .duck(_, let cwd, let pondFolder):
            return TerminalWorkspace.availability(cwd: cwd, isDirectory: isDirectory).folder
                ?? TerminalWorkspace.availability(cwd: pondFolder, isDirectory: isDirectory).folder
        case .pond(_, let folder):
            return TerminalWorkspace.availability(cwd: folder, isDirectory: isDirectory).folder
        }
    }
}
