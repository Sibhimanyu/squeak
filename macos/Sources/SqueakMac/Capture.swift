import AppKit
import SqueakMacCore
import SwiftUI

/// SQUEAK_MAC_CAPTURE=<prefix>: opens the conversation window, waits for the first
/// catalog, writes <prefix>-window.png and <prefix>-popover.png from the views'
/// own pixels (no Screen Recording permission), then quits. Read-only: it never sends.
@MainActor
enum CaptureRunner {
    static func run(prefix: String, model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        if let a = env["SQUEAK_MAC_APPEARANCE"] { NSApp.appearance = NSAppearance(named: a == "light" ? .aqua : .darkAqua) }
        await model.broker.setMode(.foreground)
        await wait(seconds: 8) { model.hasLoaded }
        if let s = model.ordered.flattened.first(where: { $0.replyTarget != nil }) ?? model.ordered.flattened.first {
            model.select(s.key)
            await wait(seconds: 4) { !model.messages.isEmpty }
        }
        try? await Task.sleep(for: .milliseconds(800))

        let win = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1040, height: 700),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.contentView = NSHostingView(rootView: ConversationView().environment(model))
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(1))
        write(win.contentView, to: "\(prefix)-window.png")

        let pop = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 360, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
        pop.contentView = NSHostingView(rootView: PopoverView().environment(model))
        pop.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(700))
        write(pop.contentView, to: "\(prefix)-popover.png")
        NSApp.terminate(nil)
    }

    private static func wait(seconds: Double, until condition: () -> Bool) async {
        let end = Date().addingTimeInterval(seconds)
        while !condition(), Date() < end { try? await Task.sleep(for: .milliseconds(150)) }
    }

    private static func write(_ view: NSView?, to path: String) {
        guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: path))
    }
}
