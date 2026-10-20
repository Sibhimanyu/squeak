import AppKit
import SqueakMacCore
import SwiftUI

/// The refinement screens with demo data only, for review: the real quick composer opened on demo-6's
/// finished reply, the context a clicked notification shows. Demo mode disables the network, reporting,
/// the cache and every send, so nothing here reaches a live chat.
enum RefinementDemo {
    /// demo-6 is a long, rich reply: the case the clipping and expansion checks need.
    static let contextKey = SessionKey(provider: "conductor", hostSessionId: "demo-6")

    /// The same typed open a clicked notification makes, anchored on the reply's message.
    static var contextOpen: PendingNotificationOpen {
        PendingNotificationOpen(
            key: contextKey,
            anchor: NotificationAnchor(eventId: "demo-context-capture", kind: .finished, at: Date(), messageId: "2")
        )
    }

    /// Opens the quick composer on demo-6's reply and leaves it open.
    @MainActor static func showContext() {
        QuickComposerController.shared.show(notification: contextOpen)
    }
}

extension CaptureRunner {
    /// SQUEAK_MAC_CAPTURE_ONLY=refinements (demo only): the quick composer on demo-6's reply, dark and
    /// light, written to <prefix>-context-dark.png and <prefix>-context-light.png. The composer is the
    /// real panel: `QuickPanel` is found among the app's windows, so nothing is drawn in its place.
    /// Offscreen capture cannot draw the window material, so the panel is captured as its own view.
    static func runContextPreview(prefix: String, model: AppModel) async {
        for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            NSApp.appearance = NSAppearance(named: appearance)
            RefinementDemo.showContext()
            // Layout and the transcript load are asynchronous; one second covers both in demo mode.
            try? await Task.sleep(for: .seconds(1))
            if let panel = NSApp.windows.first(where: { $0 is QuickPanel && $0.isVisible }) {
                write(panel.contentView, to: "\(prefix)-context-\(name).png")
            } else {
                AppLog.info("capture: no quick composer panel to write for \(name)")
            }
            QuickComposerController.shared.hide()
            try? await Task.sleep(for: .milliseconds(300))
        }
        if model.demoMode { writeLayoutValidation(prefix: prefix, model: model) }
    }

    /// Lays the composer out at three screen heights with the longest reply and a multiline draft, plus
    /// one compact reply, and records whether each fits its screen in `<prefix>-layout.json`. Sizes come
    /// from the real pill (`QuickContextCapture.fittingHeight`), which is hosted unattached, so the
    /// supplied height is what it lays out against. This is evidence: a case that does not fit is
    /// recorded as not fitting, and nothing here changes the layout.
    static func writeLayoutValidation(prefix: String, model: AppModel) {
        let draftLines = 40
        let draft = (1...draftLines).map { "Draft line \($0): a note to Claude about the Quit behaviour." }.joined(separator: "\n")
        var cases: [[String: Any]] = []
        for screen: CGFloat in [440, 600, 900] {
            cases.append(layoutCase("long-expanded-\(Int(screen))", model: model, long: true, expanded: true, screenHeight: screen, fieldText: draft, draftLines: draftLines))
        }
        // Collapsed long reply: the measured height must be the clipped reply, not its full natural height.
        cases.append(layoutCase("long-collapsed-900", model: model, long: true, expanded: false, screenHeight: 900, fieldText: "", draftLines: 0))
        cases.append(layoutCase("compact-reply", model: model, long: false, expanded: false, screenHeight: 900, fieldText: "", draftLines: 0))
        let report: [String: Any] = ["allFit": cases.allSatisfy { ($0["fits"] as? Bool) == true }, "cases": cases]
        guard let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) else { return }
        let path = "\(prefix)-layout.json"
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: path))
    }

    private static func layoutCase(_ name: String, model: AppModel, long: Bool, expanded: Bool, screenHeight: CGFloat, fieldText: String, draftLines: Int) -> [String: Any] {
        let measured = QuickContextCapture.fittingHeight(model: model, long: long, expanded: expanded, screenHeight: screenHeight, fieldText: fieldText)
        return [
            "name": name,
            "long": long,
            "expanded": expanded,
            "draftLines": draftLines,
            "screenHeight": Double(screenHeight),
            "measuredHeight": Double(measured),
            "fits": measured <= screenHeight + 1,
        ]
    }
}
