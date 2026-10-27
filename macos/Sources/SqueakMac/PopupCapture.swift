import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=popup: every screen of the menu-bar popup from DemoData, no
    /// network and no send. Writes <prefix>-popup-<screen>.png for home, needs-you, usage, controls, new-chat,
    /// new-chat-customize, workspaces and session. SQUEAK_MAC_POPUP_SCREEN=<screen> takes just one.
    /// Offscreen capture cannot draw the window material, so the panel sits on a stand-in desktop.
    static func runPopupOnly(prefix: String, model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        let nav = PopupNav.shared
        PanelBackground.captureOpaque = true  // offscreen capture cannot blur; draw the near-opaque panel token
        let screens = ["home", "needs-you", "usage", "controls", "new-chat", "new-chat-customize", "workspaces", "session"]
        let only = env["SQUEAK_MAC_POPUP_SCREEN"]
        let appearance = NSAppearance(named: env["SQUEAK_MAC_APPEARANCE"] == "light" ? .aqua : .darkAqua)
        let light = env["SQUEAK_MAC_APPEARANCE"] == "light"
        let screenHeight = env["SQUEAK_MAC_POPUP_SCREEN_HEIGHT"].flatMap(Double.init).map { CGFloat($0) }
        model.installDemoAwake(DaemonAwake(until: Date().addingTimeInterval(7200)), lidReady: true)
        nav.demoPower = DaemonPower(mode: "auto", choice: "auto", available: ["auto", "low", "high"], ready: true)
        UserDefaults.standard.set(true, forKey: "awakeWithLid")
        try? await Task.sleep(for: .milliseconds(600))
        for name in screens where only == nil || only == name {
            switch name {
            case "home": nav.show(.home)
            case "needs-you": nav.show(.needsYou)
            case "usage": nav.show(.usage)
            case "controls": nav.show(.controls)
            case "new-chat", "new-chat-customize":
                nav.show(.home)
                nav.openNewChat()
                try? await Task.sleep(for: .milliseconds(700))
                let ns = nav.newChat
                ns.form.set(planFirst: false); ns.form.apply(preset: .best)
                ns.form.text = name == "new-chat" ? "Add retries with backoff to the checkout call, and a test for the timeout case." : "Add retries with backoff to the checkout call."
                ns.customizing = name == "new-chat-customize"
                if name == "new-chat-customize" { ns.form.set(planFirst: true) }
            case "workspaces":
                nav.show(.home)
                nav.openNewChat()
                try? await Task.sleep(for: .milliseconds(700))
                nav.screen = .workspaces
            default:
                nav.show(.home)
                nav.openSession(SessionKey(provider: "conductor", hostSessionId: "demo-3"))
            }
            let backdrop: Color = light ? Color(red: 0.86, green: 0.87, blue: 0.90) : Color(red: 0.05, green: 0.06, blue: 0.09)
            let host = NSHostingView(rootView: PopoverView(drawsOwnSurface: true, screenHeightOverride: screenHeight)
                .environment(model).padding(16).background(backdrop))
            host.appearance = appearance
            let width = PopoverView.width + 32
            let win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: width, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
            win.contentView = host
            win.makeKeyAndOrderFront(nil)
            for _ in 0..<4 {
                try? await Task.sleep(for: .milliseconds(500))
                win.setContentSize(NSSize(width: width, height: host.fittingSize.height))
            }
            write(host, to: "\(prefix)-popup-\(name).png")
            win.orderOut(nil)
            if name == "new-chat-customize" { nav.newChat.form.set(planFirst: false); nav.newChat.form.apply(preset: .best) }  // leave the saved choice as it was
        }
        NSApp.terminate(nil)
    }
}
