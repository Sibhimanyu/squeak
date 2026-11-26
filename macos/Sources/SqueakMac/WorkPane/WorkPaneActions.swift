import Foundation
import SqueakMacCore

/// What a work pane belongs to: one Duck's chat, or the Pond itself (the Room and the Dashboard).
@MainActor enum WorkPaneScope {
    case duck(HostSession)
    case pond(PondWorkScope)

    var key: String {
        switch self {
        case .duck(let s): WorkPaneActions.duckKey(s)
        case .pond(let p): p.paneKey
        }
    }

    var title: String {
        switch self {
        case .duck(let s): AppModel.shared.workbenchTitle(s)
        case .pond(let p): p.name
        }
    }
}

/// The new layout's gate and the ways into the work pane. The pane opens only through these, and only from something a
/// person (or a Duck they asked) opened, never from data changing.
@MainActor enum WorkPaneActions {
    /// The new layout shows this chat as a Duck view (rail, work pane, no tabs or dock).
    static func isDuckView(_ session: HostSession?) -> Bool {
        guard MacLayoutPreference.shared.isNew, let session, let pond = PondsModel.shared.key(of: session) else { return false }
        return DuckAvatarRowView.isAvailable(pond: pond)
    }

    static func duckKey(_ session: HostSession) -> String {
        WorkPaneMetrics.duckKey(duckId: session.duckId, sessionKey: session.key.stringValue)
    }

    /// The Pond whose page is on screen, when the new layout gives it a Pond-scoped pane (a Pond with a folder on this Mac).
    static func pondScope(model: AppModel) -> PondWorkScope? {
        guard let key = pondPageKey(model: model), let project = PondsModel.shared.native(key: key) else { return nil }
        if let waiting = PondsModel.shared.pond(key: key), PondStates.isGreyedRow(waiting) { return nil }
        guard WorkPaneScopeRule.pondScope(isNewLayout: MacLayoutPreference.shared.isNew, onPondPage: true, hasLocalFolder: !project.rootPath.isEmpty) else { return nil }
        return PondWorkScope(key: key, projectId: project.id, name: PondsModel.shared.name(key: key), root: project.rootPath)
    }

    /// The Pond whose own page is on screen: its Dashboard or Room, or the New duck page opened from it.
    static func pondPageKey(model: AppModel) -> String? {
        switch model.baseLocation {
        case .pondHome(let key): return key
        case .compose(.newThread, let pond, _): return pond ?? model.selectedSession.flatMap { PondsModel.shared.key(of: $0) }
        default: return nil
        }
    }

    /// Shows the Terminal pane for the page on screen. False when this is not a new-layout page (the caller keeps the old behaviour).
    @discardableResult
    static func open(_ view: WorkPaneView, model: AppModel) -> Bool {
        guard let key = pageKey(model: model) else { return false }
        WorkPaneStore.shared.open(view, duck: key)
        return true
    }

    /// A shortcut or menu item for a list tool (Changes, Files): opens its popover on the rail, or closes it when it is the
    /// one open. False when the page has no rail (the caller keeps the old behaviour).
    @discardableResult
    static func toggleRail(_ tool: RailTool, model: AppModel) -> Bool {
        guard pageKey(model: model) != nil else { return false }
        RailPopoverState.shared.toggle(tool)
        return true
    }

    /// A person's action that shows a list (a folder revealed, a review asked for): opens the popover, never closes it.
    @discardableResult
    static func showRail(_ tool: RailTool, model: AppModel) -> Bool {
        guard pageKey(model: model) != nil else { return false }
        RailPopoverState.shared.set(tool, open: true)
        return true
    }

    /// The key of the new-layout page on screen (a Pond page or a Duck view); nil in the classic layout and elsewhere.
    private static func pageKey(model: AppModel) -> String? {
        if let pond = pondScope(model: model) { return pond.paneKey }
        guard model.focus.page == .chat, let session = model.selectedSession, isDuckView(session) else { return nil }
        return duckKey(session)
    }

    /// The page on screen as the Terminal toggle sees it (what the folder is made of).
    static func terminalPage(model: AppModel) -> TerminalToggle.Page {
        if let pond = pondScope(model: model) { return .pond(paneKey: pond.paneKey, folder: pond.root) }
        guard pageKey(model: model) != nil, let session = model.selectedSession else { return .none }
        let pondFolder = PondsModel.shared.key(of: session).flatMap { PondsModel.pondTerminalFolder($0) }
        return .duck(paneKey: duckKey(session), cwd: session.cwd, pondFolder: pondFolder)
    }

    /// The one Terminal toggle: ⌘J (Window menu), the rail's Terminal icon, the palette and the notification all end here.
    /// Opens or closes the work pane for the page on screen, in the right folder, with the keys in the shell. False when the
    /// page has no work pane (the caller keeps the classic dock).
    @discardableResult
    static func toggleTerminal(model: AppModel) -> Bool {
        let store = WorkPaneStore.shared
        let pane = store.pane
        switch TerminalToggle.decide(page: terminalPage(model: model), shownFor: pane.shown == nil ? nil : pane.current) {
        case .classic: return false
        case .close: store.close()
        case .open(let key, _):
            // Before the pane mounts, so the shell takes the keys the moment it is drawn (also a shell that already exists).
            TerminalHost.shared.focusPending = true
            store.open(.terminal, duck: key)
        }
        return true
    }

    /// A shortcut or menu item: the Terminal icon's own behaviour (opens, or closes when it is showing).
    @discardableResult
    static func toggle(_ view: WorkPaneView, model: AppModel) -> Bool {
        toggleTerminal(model: model)
    }
}
