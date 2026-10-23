import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=awake: the awake row in each state, on a stand-in panel.
    static func runAwakeOnly(prefix: String, model: AppModel) async {
        try? await Task.sleep(for: .milliseconds(600))
        let soon = Date().addingTimeInterval(130 * 60)
        let states: [(String, DaemonAwake?, Bool)] = [
            ("off", nil, true), ("off-setup", nil, false),
            ("on", DaemonAwake(until: soon), true), ("lid", DaemonAwake(until: soon, lid: true), true),
        ]
        for (name, awake, ready) in states {
            model.installDemoAwake(awake, lidReady: ready)
            let host = NSHostingView(rootView: AwakeRow().environment(model).frame(width: PopoverView.width)
                .background(Color(red: 0.14, green: 0.14, blue: 0.16)).padding(16).background(Color(red: 0.10, green: 0.10, blue: 0.12)))
            host.appearance = NSAppearance(named: .darkAqua)
            let win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: PopoverView.width + 32, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
            win.contentView = host
            win.makeKeyAndOrderFront(nil)
            for _ in 0..<2 {
                try? await Task.sleep(for: .milliseconds(400))
                win.setContentSize(NSSize(width: PopoverView.width + 32, height: host.fittingSize.height))
            }
            write(host, to: "\(prefix)-row-\(name).png")
            win.orderOut(nil)
        }
        // The Settings page, in a real window, for a few states.
        let sw = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1100, height: 900),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        sw.titlebarAppearsTransparent = true
        sw.titleVisibility = .hidden
        sw.contentView = NSHostingView(rootView: ConversationView().environment(model))
        sw.setContentSize(NSSize(width: 1100, height: 1000))
        sw.makeKeyAndOrderFront(nil)
        let hotspot = DaemonHotspot(configured: true, ssid: "Sibhi's iPhone", enabled: true, onHotspot: false, lastNote: "Joined Sibhi's iPhone's hotspot at 9:12 AM.", lastOk: true)
        let page: [(String, DaemonAwake?, Bool, DaemonAwakeEnd?, DaemonHotspot?, String?)] = [
            ("off", nil, true, DaemonAwakeEnd(reason: "battery", at: Date(), why: "Battery at 9%"), hotspot, nil),
            ("off-setup", nil, false, nil, nil, nil),
            ("lid", DaemonAwake(until: soon, lid: true, lidStatus: "on", lowPower: true, safety: "Low Power Mode on · Battery at 38%"), true, nil, hotspot, nil),
            ("lid-failed", DaemonAwake(until: soon, lid: true, lidStatus: "failed", lidProblem: "Something on this Mac turned sleep back on, so a closed lid would sleep it now."), true, nil, hotspot, nil),
        ]
        for (name, awake, ready, end, hs, problem) in page {
            model.installDemoAwake(awake, lidReady: ready, end: end, hotspot: hs, sleepProblem: problem)
            model.openSettingsInPlace(.awake)
            try? await Task.sleep(for: .milliseconds(1400))
            write(sw.contentView?.superview ?? sw.contentView, to: "\(prefix)-settings-\(name).png")
        }
        NSApp.terminate(nil)
    }
}
