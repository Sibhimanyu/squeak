import AppKit

/// Squeak launches as a menu-bar accessory (LSUIElement). While a real window is open (the
/// conversation, Settings, Welcome) it becomes a regular app: Dock icon, Cmd-Tab and its own menu
/// bar. When the last one closes it goes back to the duck alone. The popover and the quick
/// composer are panels and never count.
@MainActor
final class ActivationPolicyController {
    static let shared = ActivationPolicyController()
    private var tokens: [NSObjectProtocol] = []
    private(set) var policy: NSApplication.ActivationPolicy = .accessory

    func start() {
        guard tokens.isEmpty else { return }
        let nc = NotificationCenter.default
        let names: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification, NSWindow.didChangeOcclusionStateNotification,
        ]
        for name in names {
            tokens.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.update(closing: nil) }
            })
        }
        tokens.append(nc.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { [weak self] note in
            let closing = note.object as? NSWindow
            Task { @MainActor in self?.update(closing: closing) }
        })
    }

    static func isAppWindow(_ w: NSWindow) -> Bool {
        !(w is NSPanel) && w.styleMask.contains(.titled) && (w.isVisible || w.isMiniaturized)
    }

    /// Call just before a window is shown by code. The window is not key yet (an accessory app
    /// cannot activate), so no notification would tell us; settle it once the window had time to appear.
    func willShowWindow() {
        apply(.regular)
        takeMenuBar()
        for delay in [0.3, 1.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.update(closing: nil) }
        }
    }

    /// Make the menu bar read "Squeak" once a window is open.
    ///
    /// On macOS 14 and later an app may only activate itself when the system agrees it is the
    /// user's intent, and a click inside the menu-bar popover often does not count, so
    /// `NSApp.activate` is quietly ignored and the previous app keeps the menu bar. Asking Launch
    /// Services to open Squeak itself is always honoured (it is what a Dock click does), so that is
    /// the fallback when the direct request did not take.
    private func takeMenuBar() {
        if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            let owner = NSWorkspace.shared.menuBarOwningApplication
            AppLog.info("menu bar owner after activate: \(owner == NSRunningApplication.current ? "squeak" : "other")")
            guard owner != NSRunningApplication.current else { return }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            config.addsToRecentItems = false
            NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, error in
                if let error { AppLog.info("activate via Launch Services failed: \(error.localizedDescription)") }
            }
        }
    }

    /// The conversation window, Settings and Welcome are ordinary app windows: they live on a
    /// desktop Space and never float over another app's full-screen Space (only the popover and
    /// the quick-message panel do that). They can go full screen themselves.
    static func makeOrdinary(_ w: NSWindow) {
        var b = w.collectionBehavior
        b.remove([.fullScreenAuxiliary, .canJoinAllSpaces, .moveToActiveSpace, .transient])
        b.insert([.managed, .fullScreenPrimary])
        if b != w.collectionBehavior { w.collectionBehavior = b }
    }

    func update(closing: NSWindow?) {
        for w in NSApp.windows where Self.isAppWindow(w) { Self.makeOrdinary(w) }
        let wanted: NSApplication.ActivationPolicy =
            NSApp.windows.contains { $0 !== closing && Self.isAppWindow($0) } ? .regular : .accessory
        apply(wanted)
    }

    private func apply(_ wanted: NSApplication.ActivationPolicy) {
        guard wanted != policy else { return }
        policy = wanted
        NSApp.setActivationPolicy(wanted)
        if wanted == .regular { takeMenuBar() }
        AppLog.info("activation policy: \(wanted == .regular ? "regular" : "accessory")")
    }
}
