import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1: the conversation window from DemoData at 1100x720.
    /// Writes <prefix>-window.png (a chat that needs you) and <prefix>-window-working.png
    /// (a working chat with the "What it's doing" pill). Never sends: the model refuses in demo mode.
    static func runWindowDemo(prefix: String, model: AppModel) async {
        let win = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1100, height: 720),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.contentView = NSHostingView(rootView: ConversationView().environment(model))
        win.setContentSize(NSSize(width: 1100, height: 720))
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(800))

        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-1"))
        try? await Task.sleep(for: .milliseconds(1200))
        snapshot(win.contentView, to: "\(prefix)-window.png")

        model.select(SessionKey(provider: "conductor", hostSessionId: "demo-2"))
        try? await Task.sleep(for: .milliseconds(1200))
        snapshot(win.contentView, to: "\(prefix)-window-working.png")
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
