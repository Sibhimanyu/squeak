import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    private static var dashboardPreview: NSWindow?

    /// Read-only fixture: the actual dashboard and sidebar at normal and minimum window sizes.
    /// SQUEAK_MAC_DASHBOARD_INTERACTIVE=1 leaves the selected screen open for keyboard and pointer QA.
    static func runDashboardDemo(prefix: String, model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        for _ in 0..<40 where !model.hasLoaded { try? await Task.sleep(for: .milliseconds(100)) }
        if let chat = model.sessions.first(where: { $0.state == .working }) { model.select(chat.key) }
        WorkbenchNav.goHome(model)
        if let state = env["SQUEAK_MAC_SIDEBAR_UPDATE_STATE"] { model.updater.demoSidebarState(state) }
        if env["SQUEAK_MAC_DASHBOARD_COLD_START"] == "1" {
            var cancelledRequestRan = false
            ActivationPolicyController.shared.showWindowWhenReady { cancelledRequestRan = true }
            ActivationPolicyController.shared.cancelPendingWindow()
            await withCheckedContinuation { continuation in
                ActivationPolicyController.shared.showWindowWhenReady { continuation.resume() }
            }
            precondition(NSApp.activationPolicy() == .regular, "The main window must open after regular activation")
            precondition(!cancelledRequestRan, "Closing during startup must cancel a queued window")
        }
        let defaults = UserDefaults.standard
        let oldSidebar = defaults.object(forKey: "sidebarCollapsed")
        defaults.set(false, forKey: "sidebarCollapsed")
        defer {
            if let oldSidebar { defaults.set(oldSidebar, forKey: "sidebarCollapsed") }
            else { defaults.removeObject(forKey: "sidebarCollapsed") }
        }
        let variants: [(String, NSAppearance.Name, CGFloat, CGFloat, Bool)] = [
            ("dark", .darkAqua, 1440, 900, false),
            ("light", .aqua, 1440, 900, false),
            ("small", .darkAqua, 960, 620, false),
            ("collapsed", .darkAqua, 960, 620, true),
        ]
        for (name, appearance, width, height, collapsed) in variants {
            if let only = env["SQUEAK_MAC_DASHBOARD_SCREEN"], only != name { continue }
            let win = NSWindow(contentRect: NSRect(x: 60, y: 60, width: width, height: height),
                styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
            win.titlebarAppearsTransparent = true
            // Reproduce an update-restored window whose green control was Zoom instead of Full Screen.
            win.collectionBehavior = [.fullScreenNone]
            win.titleVisibility = .hidden
            win.appearance = NSAppearance(named: appearance)
            win.contentView = NSHostingView(rootView: ConversationView(initiallySidebarCollapsed: collapsed).environment(model))
            win.orderFront(nil)
            // Exercise the same resume -> Dashboard path a person uses, giving the history pair a real entry.
            if let resume = model.dashboardResumeSession {
                model.select(resume.key)
                try? await Task.sleep(for: .milliseconds(150))
                WorkbenchNav.goHome(model)
            }
            try? await Task.sleep(for: .milliseconds(1200))
            precondition(win.collectionBehavior.contains(.fullScreenPrimary) && !win.collectionBehavior.contains(.fullScreenNone))
            write(win.contentView?.superview ?? win.contentView, to: "\(prefix)-dashboard-\(name).png")
            if env["SQUEAK_MAC_DASHBOARD_INTERACTIVE"] == "1" {
                dashboardPreview = win
                win.makeKeyAndOrderFront(nil)
                return
            }
            win.orderOut(nil)
        }
        NSApp.terminate(nil)
    }
}
