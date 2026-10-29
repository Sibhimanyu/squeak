import AppKit
import SqueakMacCore

extension CaptureRunner {
    /// Demo-only regression evidence from the actual floating panel, without Screen Recording access.
    static func runQuickNewChat(prefix: String, model: AppModel) async {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        let controller = QuickComposerController.shared
        let state = controller.state
        var checks: [String: Bool] = [:]
        for origin in ["hotkey-origin", "popup-origin", "notification-origin"] {
            if origin == "notification-origin" {
                controller.show(notification: RefinementDemo.contextOpen)
            } else {
                controller.show(target: SessionKey(provider: "conductor", hostSessionId: "demo-3"), fromPopup: origin == "popup-origin")
            }
            state.text = "Keep this quick-message draft."
            let target = state.target
            let popupScreen = PopupNav.shared.screen
            let panel = NSApp.windows.first { $0 is QuickPanel && $0.isVisible }
            state.showNewChat(model: model)
            try? await Task.sleep(for: .milliseconds(700))
            let hadContext = state.context.isVisible
            if let panel, let visible = panel.screen?.visibleFrame {
                checks["\(origin)-fits-screen"] = panel.frame.minY >= visible.minY && panel.frame.maxY <= visible.maxY
            }
            checks["\(origin)-same-panel"] = panel?.isVisible == true && NSApp.windows.filter { $0 is QuickPanel && $0.isVisible }.count == 1
            checks["\(origin)-no-desktop"] = !NSApp.windows.contains(where: ActivationPolicyController.isAppWindow)
            checks["\(origin)-no-popup-navigation"] = PopupNav.shared.screen == popupScreen
            write(panel?.contentView, to: "\(prefix)-\(origin).png")
            state.newChat?.customizing = true
            try? await Task.sleep(for: .milliseconds(300))
            write(panel?.contentView, to: "\(prefix)-\(origin)-customize.png")
            state.screenHeight = 440
            try? await Task.sleep(for: .milliseconds(300))
            checks["\(origin)-small-screen-height"] = (panel?.frame.height ?? 1000) <= 440
            write(panel?.contentView, to: "\(prefix)-\(origin)-small-screen.png")
            state.screenHeight = panel?.screen?.visibleFrame.height ?? 900
            state.choosingNewChatWorkspace = true
            try? await Task.sleep(for: .milliseconds(300))
            write(panel?.contentView, to: "\(prefix)-\(origin)-workspaces.png")
            state.backFromNewChat()
            checks["\(origin)-workspace-back"] = state.newChat != nil && !state.choosingNewChatWorkspace
            state.backFromNewChat()
            try? await Task.sleep(for: .milliseconds(300))
            checks["\(origin)-draft-restored"] = state.newChat == nil && state.text == "Keep this quick-message draft." && state.target == target
            checks["\(origin)-context-restored"] = state.context.isVisible == hadContext
            write(panel?.contentView, to: "\(prefix)-\(origin)-back.png")
            controller.hide()
        }
        let report: [String: Any] = ["allPassed": checks.values.allSatisfy { $0 }, "checks": checks]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "\(prefix)-checks.json"))
        }
        NSApp.terminate(nil)
    }
}
