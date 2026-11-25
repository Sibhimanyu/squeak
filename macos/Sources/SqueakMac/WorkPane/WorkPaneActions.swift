import Foundation
import SqueakMacCore

extension Notification.Name {
    /// Something was opened (a file, a diff, a canvas, a shell): in the new layout the work pane shows it. `userInfo`:
    /// "view" (a `WorkPaneView` raw value) and optionally "root" (the folder it belongs to). The old layout ignores it.
    static let squeakWorkPaneOpen = Notification.Name("SqueakWorkPaneOpen")
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

    /// Tells the window something was opened. Cheap and harmless in the old layout.
    static func announce(_ view: WorkPaneView, root: String? = nil) {
        var info: [String: String] = ["view": view.rawValue]
        if let root { info["root"] = root }
        NotificationCenter.default.post(name: .squeakWorkPaneOpen, object: nil, userInfo: info)
    }

    /// Opens `view` for the chat on screen. False when this is not a Duck view (the caller keeps the old behaviour).
    @discardableResult
    static func open(_ view: WorkPaneView, model: AppModel, root: String? = nil) -> Bool {
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
        guard let session = model.selectedSession, isDuckView(session) else { return false }
        WorkPaneStore.shared.toggle(view, duck: duckKey(session))
        return true
    }
}
