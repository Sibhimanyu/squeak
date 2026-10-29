import AppKit
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=setup: the welcome, step and summary layouts
    /// in both appearances, using offline demo facts. Writes `<prefix>-<screen>-<appearance>.png`.
    static func runSetupDemo(prefix: String, model: AppModel) async {
        let screens: [(String, Int, WalkScreen?)] = [
            ("welcome", 0, nil),
            ("service", 1, .step(.service)),
            ("hooks", 1, .step(.hooks)),
            ("notifications", 1, .step(.notifications)),
            ("iphone", 1, .step(.iphone)),
            ("telegram", 1, .step(.telegram)),
            ("cliq", 1, .step(.cliq)),
            ("voice", 1, .step(.voice)),
            ("awake", 1, .step(.awake)),
            ("summary", 1, .summary),
            ("first-session", 2, nil),
        ]

        for (tone, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            for (name, step, start) in screens {
                let root = OnboardingView(step: step, walkStart: start, finish: {})
                    .environment(model)
                    .frame(width: 850, height: 640)
                let host = NSHostingView(rootView: root)
                host.frame = NSRect(x: 0, y: 0, width: 850, height: 640)
                host.appearance = NSAppearance(named: appearance)
                let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = host
                window.makeKeyAndOrderFront(nil)
                try? await Task.sleep(for: .milliseconds(220))
                write(host, to: "\(prefix)-\(name)-\(tone).png")
                window.orderOut(nil)
            }

            for name in ["notifications", "iphone", "telegram", "cliq", "voice", "awake"] {
                guard let screen = screens.first(where: { $0.0 == name }) else { continue }
                let compactRoot = OnboardingView(step: screen.1, walkStart: screen.2, finish: {})
                    .environment(model)
                    .frame(width: 760, height: 540)
                let compactHost = NSHostingView(rootView: compactRoot)
                compactHost.frame = NSRect(x: 0, y: 0, width: 760, height: 540)
                compactHost.appearance = NSAppearance(named: appearance)
                let compactWindow = NSWindow(contentRect: compactHost.frame, styleMask: [.borderless], backing: .buffered, defer: false)
                compactWindow.contentView = compactHost
                compactWindow.makeKeyAndOrderFront(nil)
                try? await Task.sleep(for: .milliseconds(220))
                write(compactHost, to: "\(prefix)-\(name)-minimum-\(tone).png")
                compactWindow.orderOut(nil)
            }
        }
        NSApp.terminate(nil)
    }
}
