import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The menu-bar panel's window: borderless, clear, with its own real window shadow. SwiftUI's
/// `MenuBarExtra` cut the system shadow under a tiny corner mask, leaving a square patch behind the
/// rounded corners; a panel we own shadows the 24pt shape `PanelSurface` draws. It can become key
/// (search, the composer's fields) without activating Squeak, like the quick composer's panel.
final class MenuPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// Hosts the panel's SwiftUI and reports the size it wants (its ideal size, not the window's), every
/// time that changes, so the panel grows and shrinks with its content.
final class MenuHostingView<Content: View>: NSHostingView<Content> {
    var onWantedSize: ((CGSize) -> Void)?
    private var last = CGSize.zero

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        report()
    }

    override func layout() {
        super.layout()
        report()
    }

    private func report() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let size = self.fittingSize
            guard size != self.last else { return }
            self.last = size
            self.onWantedSize?(size)
        }
    }
}

/// Squeak's status item and the panel it opens: the duck (and the needs-you count, awake countdown and
/// update dot, drawn by `MenuBarIcon`) in the menu bar, and a click toggles `PopoverView`.
@MainActor
final class MenuBarController: NSObject {
    static let shared = MenuBarController()

    private var item: NSStatusItem?
    private var panel: MenuPanel?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var awakeTask: Task<Void, Never>?
    /// The size SwiftUI last asked the panel to be.
    private var wanted = CGSize(width: PopoverMetrics.width, height: 520)

    var isOpen: Bool { panel?.isVisible == true }

    /// Where a panel of `size` opens under the status item, as the menu-bar panel does: New chat drops
    /// from the same spot. Nil before the item has a window.
    func dropFrame(size: CGSize) -> CGRect? {
        guard let button = item?.button, let buttonWindow = button.window else { return nil }
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let visible = (buttonWindow.screen ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return PopoverPlacement.frame(button: anchor, size: size, visible: visible)
    }

    func start(model: AppModel) {
        guard item == nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.item = item
        if let button = item.button {
            button.target = self
            button.action = #selector(toggleFromButton)
            button.sendAction(on: [.leftMouseDown])
            button.imagePosition = .imageOnly
        }
        refresh(model: model)
        track(model: model)
        model.dismissMenuBar = { [weak self] in self?.close() }
        // The awake countdown beside the duck, kept current from launch.
        awakeTask = Task { await model.pollAwake() }
    }

    /// Redraws the button from the model, and again whenever anything it read changes.
    private func track(model: AppModel) {
        withObservationTracking {
            _ = MenuBarIcon.State(model: model)
            _ = model.updateBadgeShown
            _ = model.attentionCount
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model else { return }
                self.refresh(model: model)
                self.track(model: model)
            }
        }
    }

    private func refresh(model: AppModel) {
        guard let button = item?.button else { return }
        button.image = MenuBarIcon.image(for: MenuBarIcon.State(model: model), updateDot: model.updateBadgeShown)
        button.setAccessibilityLabel((model.attentionCount > 0 ? "Squeak, \(model.attentionCount) waiting for you" : "Squeak") + (model.updateBadgeShown ? ", update available" : ""))
    }

    // MARK: Open and close

    @objc private func toggleFromButton() { toggle() }

    func toggle() { isOpen ? close() : open() }

    func open() {
        guard let button = item?.button, let buttonWindow = button.window else { return }
        let panel = self.panel ?? makePanel()
        self.panel = panel
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        if let fit = panel.contentView?.fittingSize, fit.width > 1, fit.height > 1 { wanted = fit }
        // The screen that holds the status item, not the one the pointer or the key window is on.
        panel.setFrame(placement(anchor: anchor, screen: buttonWindow.screen), display: false)
        panel.makeKeyAndOrderFront(nil)
        button.highlight(true)
        installDismissObservers()
    }

    func close() {
        removeDismissObservers()
        item?.button?.highlight(false)
        panel?.orderOut(nil)
    }

    private func makePanel() -> MenuPanel {
        let model = AppModel.shared
        let p = MenuPanel(
            contentRect: NSRect(origin: .zero, size: wanted),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.onEscape = { [weak self] in self?.close() }
        let host = MenuHostingView(rootView: PopoverView().environment(model))
        host.sizingOptions = [.intrinsicContentSize]
        host.onWantedSize = { [weak self] size in self?.resize(to: size) }
        p.contentView = host
        return p
    }

    private func placement(anchor: CGRect, screen: NSScreen?) -> CGRect {
        let visible = (screen ?? NSScreen.main)?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return PopoverPlacement.frame(button: anchor, size: wanted, visible: visible)
    }

    /// Follows the content's height: the top edge stays under the menu bar, the panel grows and shrinks below it.
    private func resize(to size: CGSize) {
        guard size.width > 1, size.height > 1 else { return }
        wanted = size
        guard let panel, panel.isVisible, let button = item?.button, let window = button.window else { return }
        let anchor = window.convertToScreen(button.convert(button.bounds, to: nil))
        let frame = placement(anchor: anchor, screen: window.screen)
        guard frame != panel.frame else { return }
        panel.setFrame(frame, display: true)
        // The shadow follows the content's alpha as it was drawn; after a resize it is stale.
        panel.invalidateShadow()
    }

    // MARK: Dismissal

    /// A click anywhere else closes the panel: other apps' clicks through the global monitor, this
    /// app's own windows through the local one (never swallowed). Menus and the status button are
    /// not "elsewhere". Another app coming forward, a Space change and Squeak resigning also close it.
    private func installDismissObservers() {
        removeDismissObservers()
        let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: clicks) { [weak self] event in
            MainActor.assumeIsolated { self?.handleLocalClick(in: event.window) }
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: clicks) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
        let center = NSWorkspace.shared.notificationCenter
        workspaceObservers = [
            center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            },
            center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
                let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
                guard app != NSRunningApplication.current else { return }
                MainActor.assumeIsolated { self?.close() }
            },
        ]
        observers = [
            NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            },
        ]
    }

    private func removeDismissObservers() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        workspaceObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
        observers.forEach(NotificationCenter.default.removeObserver)
        localMonitor = nil; globalMonitor = nil; workspaceObservers = []; observers = []
    }

    private func handleLocalClick(in window: NSWindow?) {
        if let window {
            // The panel, its menus (popUpMenu level and above) and the status button's own window
            // (its action toggles) are not outside.
            if window === panel || window === item?.button?.window || window.parent === panel
                || window.level.rawValue >= NSWindow.Level.popUpMenu.rawValue || SqueakMenuWindows.contains(window) { return }
        }
        close()
    }
}
