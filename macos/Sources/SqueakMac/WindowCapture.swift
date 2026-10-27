import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1: the conversation window from DemoData at 1100x720.
    /// Writes <prefix>-window.png (a chat that needs you) and <prefix>-window-working.png
    /// (a working chat with the "What it's doing" pill). Never sends: the model refuses in demo mode.
    static func runWindowDemo(prefix: String, model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        let win = NSWindow(
            contentRect: NSRect(x: 60, y: 60, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        let host = NSHostingView(rootView: ConversationView().environment(model))
        win.contentView = host
        win.setContentSize(NSSize(width: 1200, height: 800))
        win.makeKeyAndOrderFront(nil)
        if env["SQUEAK_MAC_GLASS"] == "1" { NSApp.activate(ignoringOtherApps: true) }
        model.installDemoAwake(DaemonAwake(until: Date().addingTimeInterval(7200)), lidReady: false)  // Home's status strip
        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-1"))
        try? await Task.sleep(for: .milliseconds(1800))
        // The window's own frame view includes the toolbar; fall back to the content view.
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window.png")
        if let id = env["SQUEAK_MAC_WINDOW_ID_FILE"] {
            try? "\(win.windowNumber)".write(toFile: id, atomically: true, encoding: .utf8)
            try? await Task.sleep(for: .seconds(Double(env["SQUEAK_MAC_HOLD"] ?? "6") ?? 6))
        }

        // Needs you (the decision cards) and Sessions (grouped by status), then a chat.
        let savedAsks = DemoData.make().asks
        model.demoSetAsks([:])
        model.navFilter = .needsYou
        try? await Task.sleep(for: .milliseconds(800))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window-needsyou.png")
        model.demoSetAsks(savedAsks)
        model.navFilter = .all
        try? await Task.sleep(for: .milliseconds(800))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window-sessions.png")
        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-3"))
        try? await Task.sleep(for: .milliseconds(1200))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window-working.png")
        // A long, well-formatted answer: the document typesetting (headings, lists, a table, code, a quote).
        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-6"))
        try? await Task.sleep(for: .milliseconds(1200))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window-message.png")
        // The Usage screen: its sidebar item selected, the fuller view in the detail column.
        model.navFilter = .usage
        try? await Task.sleep(for: .milliseconds(1200))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window-usage.png")
        win.orderOut(nil)
    }

    private static func snapshot(_ view: NSView?, to path: String) {
        guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: path))
    }
}
