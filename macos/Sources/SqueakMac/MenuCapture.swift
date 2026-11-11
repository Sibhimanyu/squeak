import AppKit
import SwiftUI

@Observable @MainActor
private final class MenuCaptureState {
    var actions: [String] = []
    var checked = false
    var choice = "first"
    var showPond = false
    var pond = NewPondState()
}

private struct MenuCaptureFixture: View {
    @Bindable var state: MenuCaptureState
    var body: some View {
        if state.showPond {
            NewPondPage(state: state.pond).background(Theme.bg)
        } else {
            VStack(spacing: 24) {
                Text("Pond actions").font(.system(size: 20, weight: .semibold))
                    .frame(width: 280, height: 60)
                    .squeakContextMenu { MenuCaptureItems(state: state) }
                    .accessibilityLabel("Pond context menu target")
                SqueakPicker("Model", selection: $state.choice) {
                    SqueakChoice(title: "First model", value: "first")
                    SqueakChoice(title: "Second model", value: "second")
                }
                .frame(width: 280)
                Text("Selected: \(state.choice). Pinned: \(state.checked ? "on" : "off"). Actions: \(state.actions.joined(separator: ", "))")
                    .font(.system(size: 12)).foregroundStyle(Theme.muted)
                Button("Open New pond field") { state.showPond = true }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
        }
    }
}

private struct MenuCaptureItems: View {
    @Bindable var state: MenuCaptureState
    var body: some View {
        Button("New branch…") { state.actions.append("branch") }.keyboardShortcut("n", modifiers: [.command, .shift])
        Button("Unavailable action") { state.actions.append("disabled") }.disabled(true)
        Toggle("Keep at the top", isOn: $state.checked)
        Divider()
        SqueakMenu("More") {
            Button("Nested action") { state.actions.append("nested") }
        }
        Button("Hide pond", role: .destructive) { state.actions.append("hide") }
    }
}

extension CaptureRunner {
    private static var menuPreview: NSWindow?

    /// Offline visual fixtures; INTERACTIVE leaves disposable controls open for actual pointer/keyboard QA.
    static func runMenuChromeDemo(prefix: String, model: AppModel) async {
        let state = MenuCaptureState()
        let win = NSWindow(contentRect: NSRect(x: 150, y: 150, width: 700, height: 540),
                           styleMask: [.titled, .closable], backing: .buffered, defer: false)
        win.title = "Squeak menu QA"
        win.appearance = NSAppearance(named: .darkAqua)
        if ProcessInfo.processInfo.environment["SQUEAK_MAC_MENU_INTERACTIVE"] == "1" {
            menuPreview = win
            win.contentView = NSHostingView(rootView: MenuCaptureFixture(state: state).environment(model))
            NSApp.activate(ignoringOtherApps: true)
            win.makeKeyAndOrderFront(nil)
            return
        }
        for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            win.appearance = NSAppearance(named: appearance)
            win.contentView = NSHostingView(rootView: NewPondPage(state: state.pond).environment(model).background(Theme.bg))
            win.orderFront(nil)
            try? await Task.sleep(for: .milliseconds(400))
            writeTop(win.contentView, height: 210, to: "\(prefix)-new-pond-\(name).png")
            let menu = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 284, height: 192),
                                styleMask: [.borderless], backing: .buffered, defer: false)
            menu.appearance = NSAppearance(named: appearance)
            menu.contentView = NSHostingView(rootView: SqueakMenuSurface(close: {}, perform: {}) { MenuCaptureItems(state: state) })
            menu.orderFront(nil)
            try? await Task.sleep(for: .milliseconds(300))
            write(menu.contentView, to: "\(prefix)-context-\(name).png")
            menu.orderOut(nil)
        }
        win.orderOut(nil)
        NSApp.terminate(nil)
    }
}
