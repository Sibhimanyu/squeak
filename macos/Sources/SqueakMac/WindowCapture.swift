import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// Offline compose-page captures in the real desktop shell, including the minimum window size.
    static func runComposeDemo(prefix: String, model: AppModel) async {
        let win = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 1100, height: 720),
                           styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.contentView = NSHostingView(rootView: ConversationView().environment(model))
        win.makeKeyAndOrderFront(nil)
        let compose = NewChatController.shared
        compose.state.prepare(model: model, preselect: nil)
        compose.page = .newChat
        try? await Task.sleep(for: .milliseconds(1400))
        compose.state.form.text = "Add retries with backoff to the checkout call, and a test for the timeout case."
        for customized in [false, true] {
            compose.state.customizing = customized
            try? await Task.sleep(for: .milliseconds(600))
            snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-desktop-newchat\(customized ? "-customize" : "").png")
        }
        win.setContentSize(NSSize(width: 900, height: 600))
        try? await Task.sleep(for: .milliseconds(600))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-desktop-newchat-small.png")
        compose.quickState.prepare(model: model, explicit: SessionKey(provider: "conductor", hostSessionId: "demo-3"))
        compose.page = .quickMessage
        try? await Task.sleep(for: .milliseconds(600))
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-desktop-quickmessage.png")
        win.orderOut(nil)
        NSApp.terminate(nil)
    }

    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=sidebar: capture collapsed and expanded
    /// main and Settings sidebars, exercising ⌘B and ⌘\\ between the states.
    static func runSidebarDemo(prefix: String, model: AppModel) async {
        let win = NSWindow(
            contentRect: NSRect(x: 60, y: 60, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        win.contentView = NSHostingView(rootView: ConversationView(initiallySidebarCollapsed: true)
            .environment(model))
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-1"))
        try? await Task.sleep(for: .milliseconds(1800))
        if let content = win.contentView { logSidebarWidth(in: content, state: "collapsed") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-main.png")

        var motion: [[String: Any]] = []
        motion.append(await sampleSidebarMotion("main-expand", in: win, prefix: prefix))
        motion.append(await sampleSidebarMotion("main-collapse", in: win, prefix: prefix))
        motion.append(await sampleSidebarMotion("main-interrupted-expand", in: win, prefix: prefix, reverseAt: 5))

        // Reproduce Home ↔ project navigation while the sidebar is collapsed. The demo
        // project data contains "squeak" and this exercises the same NavigationSplitView.
        await sendCommandB(to: win)
        await waitForSidebarWidth(220, in: win)
        model.navFilter = .home
        model.openProject("squeak")
        try? await Task.sleep(for: .milliseconds(500))
        if let content = win.contentView { logSidebarWidth(in: content, state: "project expanded before collapse") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-project-expanded.png")
        await sendCommandB(to: win)
        await waitForSidebarWidth(64, in: win)
        try? await Task.sleep(for: .milliseconds(300))
        if let content = win.contentView { logSidebarWidth(in: content, state: "project collapsed") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-project-collapsed.png")
        model.closeProject()
        try? await Task.sleep(for: .milliseconds(500))
        if let content = win.contentView { logSidebarWidth(in: content, state: "Home after returning from collapsed project") }
        snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-home-collapsed.png")

        for cycle in 1...3 {
            model.openProject("squeak")
            try? await Task.sleep(for: .milliseconds(400))
            if let content = win.contentView { logSidebarWidth(in: content, state: "collapsed project cycle \(cycle)") }
            if cycle == 1 { snapshot(win.contentView?.superview ?? win.contentView, to: "\(prefix)-sidebar-project-reopened.png") }
            model.closeProject()
            try? await Task.sleep(for: .milliseconds(400))
            if let content = win.contentView { logSidebarWidth(in: content, state: "collapsed Home cycle \(cycle)") }
        }

        await sendCommandB(to: win)
        await waitForSidebarWidth(220, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "main expanded with Cmd+B") }
        await sendCommandB(to: win)
        await waitForSidebarWidth(64, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "main collapsed with Cmd+B") }

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
        await sendCommandB(to: win)
        await waitForSidebarWidth(216, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "Settings expanded with Cmd+B") }
        await sendCommandB(to: win)
        await waitForSidebarWidth(64, in: win)
        if let content = win.contentView { logSidebarWidth(in: content, state: "Settings collapsed with Cmd+B") }
        motion.append(await sampleSidebarMotion("settings-expand", in: win, prefix: prefix))
        motion.append(await sampleSidebarMotion("settings-collapse", in: win, prefix: prefix))
        let report: [String: Any] = ["reduceMotion": reduceMotion, "sequences": motion]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: "\(prefix)-sidebar-motion.json"))
        }
        win.orderOut(nil)
        NSApp.terminate(nil)
    }

    /// Samples the actual NSSplitView sidebar on the main run loop, including interrupted motion.
    private static func sampleSidebarMotion(_ name: String, in window: NSWindow, prefix: String, reverseAt: Int? = nil) async -> [String: Any] {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(100))
        var samples: [[String: Double]] = []
        let start = ProcessInfo.processInfo.systemUptime
        NotificationCenter.default.post(name: .squeakToggleSidebar, object: nil)
        for frame in 0..<30 {
            if frame == reverseAt { NotificationCenter.default.post(name: .squeakToggleSidebar, object: nil) }
            if let content = window.contentView, let width = sidebarWidth(in: content) {
                func sizers(in view: NSView) -> [SidebarColumnSizerView] {
                    (view as? SidebarColumnSizerView).map { [$0] } ?? view.subviews.flatMap { sizers(in: $0) }
                }
                let sizing = sizers(in: content)
                samples.append(["milliseconds": (ProcessInfo.processInfo.systemUptime - start) * 1000, "width": width,
                                "target": sizing.first?.configuration.ideal ?? -1, "sizers": Double(sizing.count)])
            }
            // Optional stills are visual references; caching the view blocks the main
            // thread, so use the default width-only run for timing measurements.
            if ProcessInfo.processInfo.environment["SQUEAK_MAC_CAPTURE_MOTION_FRAMES"] == "1", [0, 3, 6, 12, 20].contains(frame) {
                snapshot(window.contentView?.superview ?? window.contentView, to: "\(prefix)-\(name)-frame-\(frame).png")
            }
            try? await Task.sleep(for: .milliseconds(16))
        }
        print("CaptureRunner motion \(name): \(samples.map { Int($0["width"] ?? 0) })")
        return ["name": name, "samples": samples]
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

    private static func sendCommandB(to window: NSWindow) async {
        NSApp.activate(ignoringOtherApps: true)
        try? await Task.sleep(for: .milliseconds(200))
        window.makeKeyAndOrderFront(nil)
        guard let down = NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: "b", charactersIgnoringModifiers: "b", isARepeat: false, keyCode: 11
        ), let up = NSEvent.keyEvent(
            with: .keyUp, location: .zero, modifierFlags: .command,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: "b", charactersIgnoringModifiers: "b", isARepeat: false, keyCode: 11
        ) else { return }
        NSApp.sendEvent(down)
        NSApp.sendEvent(up)
        try? await Task.sleep(for: .milliseconds(200))
    }

    private static func waitForSidebarWidth(_ expected: CGFloat, in window: NSWindow) async {
        // A native layout pass can briefly use the destination width before the
        // transition clock's next tick. Wait for its duration before checking rest.
        try? await Task.sleep(for: .seconds(SidebarColumnSizerView.duration + 0.05))
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
