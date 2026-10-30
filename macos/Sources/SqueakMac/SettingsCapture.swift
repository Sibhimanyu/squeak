import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// Offline settings review, using the real sidebar and page content in both appearances.
    static func runSettingsDemo(prefix: String, model: AppModel) async {
        let win = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 1100, height: 900),
                           styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.contentView = NSHostingView(rootView: ConversationView().environment(model))
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            for section in [SettingsSection.general, .notifications, .awake, .conductor, .connections, .telegram, .cliq, .iphone, .voice, .privacy, .about] {
                model.openSettingsInPlace(section)
                try? await Task.sleep(for: .milliseconds(650))
                write(win.contentView?.superview ?? win.contentView, to: "\(prefix)-\(section.rawValue)-\(name).png")
            }
        }
        win.setContentSize(NSSize(width: 900, height: 600))
        for section in [SettingsSection.general, .notifications, .connections, .iphone, .voice] {
            model.openSettingsInPlace(section)
            try? await Task.sleep(for: .milliseconds(650))
            write(win.contentView?.superview ?? win.contentView, to: "\(prefix)-\(section.rawValue)-small.png")
        }
        win.orderOut(nil)
        NSApp.terminate(nil)
    }
}
