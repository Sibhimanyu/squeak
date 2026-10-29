import AppKit
import SwiftUI

extension CaptureRunner {
    /// Offline review of the first-session walkthrough and shared empty guidance in both appearances.
    static func runFirstSession(prefix: String, model: AppModel) async {
        for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            for (screen, view, size) in [
                ("walkthrough", AnyView(OnboardingView(stage: .firstWin, finish: {}).environment(model)), NSSize(width: 520, height: 600)),
                ("empty", AnyView(SessionEmptyView().environment(model).frame(width: 380).background(Theme.bg)), NSSize(width: 380, height: 240)),
            ] {
                let host = NSHostingView(rootView: view)
                host.appearance = NSAppearance(named: appearance)
                let win = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
                win.contentView = host
                win.makeKeyAndOrderFront(nil)
                try? await Task.sleep(for: .milliseconds(600))
                if screen == "empty" { win.setContentSize(host.fittingSize) }
                try? await Task.sleep(for: .milliseconds(300))
                write(host, to: "\(prefix)-\(screen)-\(name).png")
                win.orderOut(nil)
            }
        }
        NSApp.terminate(nil)
    }
}
