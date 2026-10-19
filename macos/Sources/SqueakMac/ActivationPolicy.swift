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
        NSApp.activate(ignoringOtherApps: true)
        for delay in [0.3, 1.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.update(closing: nil) }
        }
    }

    func update(closing: NSWindow?) {
        let wanted: NSApplication.ActivationPolicy =
            NSApp.windows.contains { $0 !== closing && Self.isAppWindow($0) } ? .regular : .accessory
        apply(wanted)
    }

    private func apply(_ wanted: NSApplication.ActivationPolicy) {
        guard wanted != policy else { return }
        policy = wanted
        NSApp.setActivationPolicy(wanted)
        if wanted == .regular {
            // So the menu bar reads "Squeak", not the app that was in front.
            NSApp.activate(ignoringOtherApps: true)
        }
        AppLog.info("activation policy: \(wanted == .regular ? "regular" : "accessory")")
    }
}
