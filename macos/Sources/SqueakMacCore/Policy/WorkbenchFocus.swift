import Foundation

/// Where a chat sits: its pond (directory key) and its workspace (stream) id.
public struct ChatPlace: Equatable, Sendable {
    public var pond: String?
    public var workspace: String?
    /// Ducks mode: the branch the chat's duck works on ("main" on main).
    public var branch: String?
    public init(pond: String?, workspace: String?, branch: String? = nil) { self.pond = pond; self.workspace = workspace; self.branch = branch }
}

/// What the person is looking at, derived from the one `WorkbenchLocation`. Every surface (sidebar rows, header crumb,
/// tab strip, right panel) reads this and decides nothing itself: a pond row is lit whenever `pond` is that pond (its
/// home, a thread, its settings, a creation page aimed at it, or a chat inside it), a stream row whenever `workspace`
/// is that stream, the Dashboard when `page == .home`.
public struct WorkbenchFocus: Equatable, Sendable {
    public enum Page: Equatable, Sendable {
        case home
        /// A pond's own page: home, a thread opened from it, or its settings.
        case pond
        case chat
        case compose(ComposePage)
        case settings(SettingsSection)
        case usage
        case archived
    }

    public var page: Page
    public var pond: String?
    public var workspace: String?
    /// Ducks mode (`ducksOwnBranch`): the branch of the open duck, "main" on main. The mode's stand-in for `workspace`;
    /// nil with the flag off, and on pages that are not a duck.
    public var branch: String?
    public var chat: SessionKey?
    /// How the person belongs to `pond` (the directory's `access`); every surface reads this one value for its chrome.
    public var access: PondMembership

    public init(page: Page, pond: String? = nil, workspace: String? = nil, chat: SessionKey? = nil, access: PondMembership = .owner, branch: String? = nil) {
        self.page = page; self.pond = pond; self.workspace = workspace; self.branch = branch; self.chat = chat; self.access = access
    }

    public static let home = WorkbenchFocus(page: .home)

    /// `place` finds a chat's pond and workspace (the sidebar's tree and the pond directory); nil when it is not listed.
    public static func resolve(_ location: WorkbenchLocation, place: (SessionKey) -> ChatPlace?,
                               access: (String) -> PondMembership = { _ in .owner }) -> WorkbenchFocus {
        var f = resolveLocation(location, place: place)
        if let pond = f.pond { f.access = access(pond) }
        return f
    }

    private static func resolveLocation(_ location: WorkbenchLocation, place: (SessionKey) -> ChatPlace?) -> WorkbenchFocus {
        switch location {
        case .home: return .home
        case .pondHome(let p), .pondThread(let p, _, _), .pondSettings(let p): return WorkbenchFocus(page: .pond, pond: p)
        case .archived: return WorkbenchFocus(page: .archived)
        case .chat(let key):
            let at = place(key)
            return WorkbenchFocus(page: .chat, pond: at?.pond, workspace: at?.workspace, chat: key, branch: at?.branch)
        case .compose(let page, let pond, let workspace): return WorkbenchFocus(page: .compose(page), pond: pond, workspace: workspace)
        case .settings(let s): return WorkbenchFocus(page: .settings(s))
        case .usage: return WorkbenchFocus(page: .usage)
        }
    }

    public var isSettings: Bool { if case .settings = page { true } else { false } }
    public var isPondPage: Bool { page == .pond || page == .archived }
    public var composePage: ComposePage? { if case .compose(let p) = page { p } else { nil } }
}
