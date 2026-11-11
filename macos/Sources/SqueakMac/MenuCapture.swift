import AppKit
import SwiftUI

@Observable @MainActor
private final class MenuCaptureState {
    var actions: [String] = []
    var checked = false
    var choice = "first"
}

private struct MenuCaptureFixture: View {
    @Bindable var state: MenuCaptureState
    var body: some View {
        VStack(spacing: 24) {
            Text("Pond actions").font(.system(size: 20, weight: .semibold))
                .frame(width: 280, height: 60)
                .squeakContextMenu {
                    Button("New branch…") { state.actions.append("branch") }.keyboardShortcut("n", modifiers: [.command, .shift])
                    Button("Unavailable action") { state.actions.append("disabled") }.disabled(true)
                    Toggle("Keep at the top", isOn: $state.checked)
                    Divider()
                    SqueakMenu("More") {
                        Button("Nested action") { state.actions.append("nested") }
                    }
                    Button("Hide pond", role: .destructive) { state.actions.append("hide") }
                }
                .accessibilityLabel("Pond context menu target")
            SqueakPicker("Model", selection: $state.choice) {
                SqueakChoice(title: "First model", value: "first")
                SqueakChoice(title: "Second model", value: "second")
            }
            .frame(width: 280)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
    }
}

extension CaptureRunner {
    /// Real secondary clicks and key events exercise custom menu presentation, values and dismissal.
    static func runMenuChromeDemo(prefix: String, model: AppModel) async {
        NSApp.activate(ignoringOtherApps: true)
        let state = MenuCaptureState()
        let win = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 700, height: 500),
                           styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.appearance = NSAppearance(named: .darkAqua)
        win.contentView = NSHostingView(rootView: MenuCaptureFixture(state: state))
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(600))

        func key(_ code: UInt16, _ chars: String) {
            let target = NSApp.keyWindow ?? win
            if let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: target.windowNumber,
                context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
                NSApp.postEvent(event, atStart: false)
            }
        }
        func click(_ point: NSPoint, right: Bool = false) {
            for type in right ? [NSEvent.EventType.rightMouseDown, .rightMouseUp] : [.leftMouseDown, .leftMouseUp] {
                if let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: win.windowNumber,
                    context: nil, eventNumber: 0, clickCount: 1, pressure: 1) { NSApp.postEvent(event, atStart: false) }
            }
        }
        func menuWindow() -> NSWindow? {
            NSApp.windows.first { $0.isVisible && $0 != win && $0.frame.width >= 280 && $0.frame.width < 400 }
        }
        // The top fixture row is the secondary-click target.
        let target = NSPoint(x: 350, y: 280)
        click(target, right: true)
        try? await Task.sleep(for: .milliseconds(600))
        precondition(menuWindow() != nil, "Secondary click must open the custom menu")
        write(menuWindow()?.contentView, to: "\(prefix)-context-dark.png")
        key(124, "\u{f703}")
        try? await Task.sleep(for: .milliseconds(100))
        precondition(state.actions.isEmpty, "Right arrow must not execute an ordinary action")
        key(125, "\u{f701}")
        key(36, "\r")
        try? await Task.sleep(for: .milliseconds(400))
        precondition(state.checked && state.actions.isEmpty, "Down must skip disabled items and Return must toggle")
        precondition(menuWindow() == nil, "Choosing an action must dismiss the menu")
        click(target, right: true)
        try? await Task.sleep(for: .milliseconds(400))
        key(53, "\u{1b}")
        try? await Task.sleep(for: .milliseconds(300))
        precondition(menuWindow() == nil, "Escape must dismiss the context menu")
        click(target, right: true)
        try? await Task.sleep(for: .milliseconds(400))
        click(NSPoint(x: 40, y: 40))
        try? await Task.sleep(for: .milliseconds(300))
        precondition(menuWindow() == nil, "Clicking outside must dismiss the menu")

        let pond = NewPondState()
        win.setContentSize(NSSize(width: 700, height: 540))
        win.contentView = NSHostingView(rootView: NewPondPage(state: pond).environment(model).background(Theme.bg))
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(600))
        writeTop(win.contentView, height: 210, to: "\(prefix)-new-pond-dark.png")
        print("Custom menu checks passed: context click, disabled rows, toggle, Escape and outside dismissal")
        win.orderOut(nil)
        NSApp.terminate(nil)
    }
}
