import AppKit
import SqueakMacCore
import SwiftUI

extension CaptureRunner {
    /// The question card from DemoData, in every shape, photographed from its own pixels: single-select,
    /// multi-select with "Something else" typed, two questions (page one and page two), a plan, and the
    /// compact forms the popover uses. Writes <prefix>-ask-*.png. Nothing is sent.
    static func runAskDemo(prefix: String, model: AppModel) async {
        func form(_ ask: PendingAsk, _ edit: (inout AskForm) -> Void) -> AskForm {
            var f = AskForm(ask); edit(&f); return f
        }
        let single = form(DemoData.singleAsk) { $0.toggle("Retry automatically", in: 0) }
        let multi = form(DemoData.multiAsk) {
            $0.toggle("Menu bar", in: 0); $0.toggle("iPhone app", in: 0)
            $0.setUsingOther(true, in: 0); $0.setOther("A hot key that works from any app", in: 0)
        }
        let two1 = form(DemoData.twoAsk) { $0.toggle("SQLite", in: 0) }
        let two2 = form(DemoData.twoAsk) {
            $0.toggle("SQLite", in: 0); $0.next(); $0.setUsingOther(true, in: 1); $0.setOther("Only the last 30 days", in: 1)
        }
        let revising = form(DemoData.planAsk) { $0.revising = true; $0.planNote = "Add a rollback step before the route goes live." }
        let cases: [(String, AnyView)] = [
            ("single", AnyView(AskCard(ask: DemoData.singleAsk, initial: single))),
            ("multi-other", AnyView(AskCard(ask: DemoData.multiAsk, initial: multi))),
            ("two-1", AnyView(AskCard(ask: DemoData.twoAsk, initial: two1))),
            ("two-2", AnyView(AskCard(ask: DemoData.twoAsk, initial: two2))),
            ("plan", AnyView(AskCard(ask: DemoData.planAsk))),
            ("plan-note", AnyView(AskCard(ask: DemoData.planAsk, initial: revising))),
            ("answered", AnyView(AskCard(ask: DemoData.singleAsk, result: .answered(via: "stopped-and-sent", note: nil)))),
            ("not-sent", AnyView(AskCard(ask: DemoData.singleAsk, result: .refused(reason: "That question has moved on. Look at the chat again.")))),
            ("compact-single", AnyView(AskCard(ask: DemoData.singleAsk, compact: true, initial: single))),
            ("compact-multi", AnyView(AskCard(ask: DemoData.multiAsk, compact: true, initial: multi))),
            ("compact-plan", AnyView(AskCard(ask: DemoData.planAsk, compact: true))),
        ]
        for (name, card) in cases {
            let compact = name.hasPrefix("compact")
            let width: CGFloat = compact ? 336 : 640
            let host = NSHostingView(rootView: card.padding(compact ? 12 : 28).frame(width: width + (compact ? 24 : 56)).background(Theme.bg))
            let w = NSWindow(contentRect: NSRect(x: 80, y: 80, width: width + (compact ? 24 : 56), height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
            w.contentView = host
            w.makeKeyAndOrderFront(nil)
            try? await Task.sleep(for: .milliseconds(500))
            w.setContentSize(NSSize(width: host.fittingSize.width, height: host.fittingSize.height))
            try? await Task.sleep(for: .milliseconds(400))
            write(w.contentView, to: "\(prefix)-ask-\(name).png")
            w.orderOut(nil)
        }
        // The popover's needs-you card with the compact question, and the window with the card under the message.
        let key = SessionKey(provider: "conductor", hostSessionId: "demo-1")
        _ = key
    }
}
