import Foundation
import SqueakMacCore

extension Notification.Name {
    /// Something was opened (a file, a diff, an artifact, a shell): in the new layout the work pane shows it. `userInfo`:
    /// "view" (a `WorkPaneView` raw value) and optionally "root" (the folder it belongs to). The old layout ignores it.
    static let squeakWorkPaneOpen = Notification.Name("SqueakWorkPaneOpen")
}

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
        guard case .pondHome(let key) = model.baseLocation, let project = PondsModel.shared.native(key: key) else { return nil }
        if let waiting = PondsModel.shared.pond(key: key), PondStates.isGreyedRow(waiting) { return nil }
        guard WorkPaneScopeRule.pondScope(isNewLayout: MacLayoutPreference.shared.isNew, onPondPage: true, hasLocalFolder: !project.rootPath.isEmpty) else { return nil }
        return PondWorkScope(key: key, projectId: project.id, name: PondsModel.shared.name(key: key), root: project.rootPath)
    }

    /// Tells the window something was opened. Cheap and harmless in the old layout.
    static func announce(_ view: WorkPaneView, root: String? = nil) {
        var info: [String: String] = ["view": view.rawValue]
        if let root { info["root"] = root }
        NotificationCenter.default.post(name: .squeakWorkPaneOpen, object: nil, userInfo: info)
    }

    /// Opens `view` for the chat on screen. False when this is not a Duck view (the caller keeps the old behaviour).
    @discardableResult
    static func open(_ view: WorkPaneView, model: AppModel, root: String? = nil) -> Bool {
        if let pond = pondScope(model: model) {
            if pond.owns(root: root) { WorkPaneStore.shared.open(view, duck: pond.paneKey) }
            return true
        }
        guard let session = model.selectedSession, isDuckView(session) else { return false }
        if let root, let cwd = session.cwd, !cwd.isEmpty, cwd != root { return true }
        WorkPaneStore.shared.open(view, duck: duckKey(session))
        return true
    }

    static func open(_ note: Notification, model: AppModel) {
        guard let raw = note.userInfo?["view"] as? String, let view = WorkPaneView(rawValue: raw) else { return }
        open(view, model: model, root: note.userInfo?["root"] as? String)
    }

    /// A shortcut or menu item: the icon's own behaviour (opens, or closes when it is the one showing).
    @discardableResult
    static func toggle(_ view: WorkPaneView, model: AppModel) -> Bool {
        if let pond = pondScope(model: model) {
            WorkPaneStore.shared.toggle(view, duck: pond.paneKey)
            return true
        }
        guard let session = model.selectedSession, isDuckView(session) else { return false }
        WorkPaneStore.shared.toggle(view, duck: duckKey(session))
        return true
    }
}

extension WorkPaneScope {
    /// The chat whose Changes the pane reads: the Duck's own, or (for a Pond) a real session working in the Pond's folder.
    @MainActor func changesSession(_ model: AppModel) -> HostSession? {
        switch self {
        case .duck(let s): s
        case .pond(let p): p.changesSession(in: model.allSessions)
        }
    }
}
