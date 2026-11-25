import AppKit
import ObjectiveC
import SqueakMacCore

// DESIGN.md 8.12, Esc. macOS exits full screen when an Esc reaches the window's `cancelOperation:`. Popovers, sheets, menus,
// suggestion lists and inline editors take Esc before that. What arrives is ours: step back one level (`EscapeRule`) and
// never leave full screen. Only `cancelOperation:` is replaced; no titlebar view is touched. Ctrl-Cmd-F and the green
// button still toggle full screen.

@MainActor
enum WindowEscape {
    nonisolated(unsafe) private static var original: IMP?
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        let sel = #selector(NSResponder.cancelOperation(_:))
        let block: @convention(block) (NSWindow, Any?) -> Void = { window, sender in
            let handled = MainActor.assumeIsolated { WindowEscape.handle(window) }
            if handled { return }
            // Any other window (a popover, a panel, a sheet) keeps what it did before.
            let base = WindowEscape.original ?? class_getMethodImplementation(NSResponder.self, sel)
            if let base { unsafeBitCast(base, to: (@convention(c) (AnyObject, Selector, Any?) -> Void).self)(window, sel, sender) }
        }
        let imp = imp_implementationWithBlock(block)
        original = class_replaceMethod(NSWindow.self, sel, imp, "v@:@")
    }

    /// True when the window is the app's own (and the key is now ours, swallowed).
    private static func handle(_ window: NSWindow) -> Bool {
        let name = String(describing: type(of: window))
        guard window.styleMask.contains(.titled), !(window is NSPanel), window.sheetParent == nil, !name.contains("Popover") else { return false }
        let model = AppModel.shared
        let pane = WorkPaneStore.shared.pane
        let isNew = MacLayoutPreference.shared.isNew
        var page = EscapeRule.Page.other
        if !model.focus.isSettings {
            if case .pondHome(let key) = model.baseLocation, PondsModel.shared.native(key: key) != nil {
                page = RoomViewPref.shared.mode(for: key) == .room ? .room : .dashboard
            } else if model.focus.page == .chat, WorkPaneActions.isDuckView(model.selectedSession) {
                page = .duckChat
            }
        }
        let step = EscapeRule.step(
            isNewLayout: isNew, overlayOpen: window.attachedSheet != nil, paneOpen: pane.shown != nil, panePinned: pane.pinned,
            page: page, turnRunning: false)
        if window.attachedSheet == nil, step != .closePane, let workspace = model.pondWorkspace,
           model.tabStore.currentPondItem(workspace.project.id) != nil {
            model.leavePondItem(pond: workspace.pond)
            return true
        }
        switch step {
        case .nothing: break
        case .closePane: WorkPaneStore.shared.close()
        case .toRoom:
            if let session = model.selectedSession, let pond = PondsModel.shared.key(of: session) {
                RoomViewPref.shared.set(.room, for: pond)
                model.openPondHome(pond)
            }
        case .toDashboard:
            if case .pondHome(let key) = model.baseLocation { RoomViewPref.shared.set(.dashboard, for: key) }
        }
        return true
    }
}
