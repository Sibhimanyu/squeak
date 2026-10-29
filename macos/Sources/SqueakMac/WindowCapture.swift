import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=sidebar: capture collapsed and expanded
    /// main and Settings sidebars, exercising ⌘\\ between the states.
    static func runSidebarDemo(prefix: String, model: AppModel) async {
        let win = NSWindow(
            contentRect: NSRect(x: 60, y: 60, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.contentView = NSHostingView(rootView: ConversationView(initiallySidebarCollapsed: true).environment(model))
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-1"))
        try? await Task.sleep(for: .milliseconds(1800))
        if let content = win.contentView { logSidebarWidth(in: content, state: "collapsed") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-main.png")

        await sendCommandBackslash(to: win)
        await waitForSidebarWidth(220, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "expanded") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-main-expanded.png")

        model.openSettingsInPlace(.general)
        await waitForSidebarWidth(216, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "Settings expanded") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-settings.png")
        await sendCommandBackslash(to: win)
        await waitForSidebarWidth(64, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "Settings collapsed") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-settings-collapsed.png")
        win.orderOut(nil)
        NSApp.terminate(nil)
    }

    private static func sendCommandBackslash(to window: NSWindow) async {
        NSApp.activate(ignoringOtherApps: true)
        try? await Task.sleep(for: .milliseconds(200))
        window.makeKeyAndOrderFront(nil)
        guard let down = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: "\\", charactersIgnoringModifiers: "\\", isARepeat: false, keyCode: 42
        ), let up = NSEvent.keyEvent(
            with: .keyUp, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: "\\", charactersIgnoringModifiers: "\\", isARepeat: false, keyCode: 42
        ) else { return }
        NSApp.sendEvent(down)
        NSApp.sendEvent(up)
        try? await Task.sleep(for: .milliseconds(200))
    }

    private static func waitForSidebarWidth(_ expected: CGFloat, in window: NSWindow) async {
        for _ in 0..<30 {
            if let content = window.contentView,
               abs((sidebarWidth(in: content) ?? -1) - expected) < 1 { return }
            try? await Task.sleep(for: .milliseconds(100))
        }
    }

    private static func logSidebarWidth(in view: NSView, state: String) {
        guard let width = sidebarWidth(in: view), let split = findSplitView(in: view) else { return }
        var responder: NSResponder? = split
        var controller: NSSplitViewController?
        while let current = responder {
            if let value = current as? NSSplitViewController { controller = value; break }
            responder = current.nextResponder
        }
        guard let item = controller?.splitViewItems.first(where: { $0.behavior == .sidebar }) else { return }
        print("CaptureRunner sidebar (\(state)): \(width)pt, constraints \(item.minimumThickness)...\(item.maximumThickness)pt")
    }

    private static func sidebarWidth(in view: NSView) -> CGFloat? {
        guard let split = findSplitView(in: view) else { return nil }
        var responder: NSResponder? = split
        var controller: NSSplitViewController?
        while let current = responder {
            if let value = current as? NSSplitViewController { controller = value; break }
            responder = current.nextResponder
        }
        return controller?.splitViewItems.first(where: { $0.behavior == .sidebar })?.viewController.view.frame.width
    }

    private static func findSplitView(in view: NSView) -> NSSplitView? {
        if let split = view as? NSSplitView { return split }
        for child in view.subviews {
            if let split = findSplitView(in: child) { return split }
        }
        return nil
    }

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
