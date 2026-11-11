import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    private static var dashboardPreview: NSWindow?

    /// Exercise the real SwiftUI scene, including its native title bar and toolbar safe area.
    static func runWindowChromeDemo(prefix: String, model: AppModel) async {
        for _ in 0..<60 where !model.hasLoaded { try? await Task.sleep(for: .milliseconds(100)) }
        guard let chat = model.sessions.first(where: { $0.state == .working }) else { preconditionFailure("Missing fixture chat") }
        let defaults = UserDefaults.standard
        let keys = ["sidebarCollapsed", "inspectorOpen"]
        let saved = keys.map { defaults.object(forKey: $0) }
        let restore = {
            for (key, value) in zip(keys, saved) {
                if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
            }
        }
        defer { restore() }
        defaults.set(false, forKey: keys[0]); defaults.set(true, forKey: keys[1])
        model.select(chat.key)
        model.showConversationWindow()
        for _ in 0..<100 where model.conversationWindow?.isVisible != true { try? await Task.sleep(for: .milliseconds(100)) }
        guard let window = model.conversationWindow, window.isVisible else { preconditionFailure("Main scene did not open") }
        window.appearance = NSAppearance(named: .darkAqua)
        for (name, size) in [("windowed", NSSize(width: 1280, height: 800)), ("small", NSSize(width: 960, height: 620))] {
            window.setContentSize(size)
            try? await Task.sleep(for: .milliseconds(1200))
            write(window.contentView?.superview, to: "\(prefix)-chrome-\(name).png")
            writeTop(window.contentView?.superview, height: 90, to: "\(prefix)-chrome-\(name)-header.png")
        }
        if ProcessInfo.processInfo.environment["SQUEAK_MAC_CHROME_FULLSCREEN"] == "1" {
            window.makeKeyAndOrderFront(nil)
            window.toggleFullScreen(nil)
            for _ in 0..<80 where !window.styleMask.contains(.fullScreen) { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .seconds(2))
            precondition(window.styleMask.contains(.fullScreen) && model.conversationFullScreen, "Full screen must complete")
            write(window.contentView?.superview, to: "\(prefix)-chrome-fullscreen.png")
            window.toggleFullScreen(nil)
            for _ in 0..<80 where window.styleMask.contains(.fullScreen) { try? await Task.sleep(for: .milliseconds(100)) }
            try? await Task.sleep(for: .seconds(2))
            precondition(!window.styleMask.contains(.fullScreen) && !model.conversationFullScreen, "Window must leave full screen")
            window.setContentSize(NSSize(width: 1280, height: 800))
            try? await Task.sleep(for: .milliseconds(1000))
            write(window.contentView?.superview, to: "\(prefix)-chrome-restored.png")
        }
        // terminate exits the process without unwinding the async function's defer.
        restore()
        QuitIntent.shared.quitCompletely()
    }

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
            if env["SQUEAK_MAC_VERIFY_SIDEBAR_CHROME"] == "1", name == "small", let resume = model.dashboardResumeSession {
                // Exercise the same mounted window: collapse must retain history and its shortcut handlers.
                defaults.set(true, forKey: "sidebarCollapsed")
                try? await Task.sleep(for: .milliseconds(300))
                NotificationCenter.default.post(name: .squeakNavigateBack, object: nil)
                try? await Task.sleep(for: .milliseconds(300))
                precondition(model.selected == resume.key, "Back must work after collapsing the sidebar")
                NotificationCenter.default.post(name: .squeakNavigateForward, object: nil)
                try? await Task.sleep(for: .milliseconds(300))
                precondition(model.selected == nil, "Forward must return to Dashboard while collapsed")
                defaults.set(false, forKey: "sidebarCollapsed")
                try? await Task.sleep(for: .milliseconds(300))
                NotificationCenter.default.post(name: .squeakNavigateBack, object: nil)
                try? await Task.sleep(for: .milliseconds(300))
                precondition(model.selected == resume.key, "Reopening the sidebar must preserve history")
                NotificationCenter.default.post(name: .squeakNavigateForward, object: nil)
                try? await Task.sleep(for: .milliseconds(300))
                precondition(model.selected == nil, "Forward history must survive reopening the sidebar")
            }
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
