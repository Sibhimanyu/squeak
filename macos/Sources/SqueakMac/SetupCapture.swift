import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=setup: the welcome, step and summary layouts
    /// in both appearances, using offline demo facts. Writes `<prefix>-<screen>-<appearance>.png`.
    static func runSetupDemo(prefix: String, model: AppModel) async {
        let screens: [(String, SetupStage)] = SetupStage.allCases.map { ($0.rawValue, $0) }

        for (tone, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            for (name, stage) in screens {
                let root = OnboardingView(stage: stage, finish: {})
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

            for (name, stage) in screens where stage == .away || stage == .firstWin {
                let compactRoot = OnboardingView(stage: stage, finish: {})
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
