import AppKit
import SqueakMacCore
import SwiftUI

/// The quick message pill with a notification's context, for offline screenshots. Demo data only:
/// it reads nothing, marks nothing read and sends nothing. Use it from a capture run
/// (`SQUEAK_MAC_DEMO=1`), the same way the other capture views are hosted:
///
///     let state = QuickContextCapture.state(model: AppModel.shared)
///     host(QuickComposerView(close: {}).environment(AppModel.shared).environment(state))
///
/// `AppModel.shared.installDemo()` must have run, so the destination chip has a session.
@MainActor
enum QuickContextCapture {
    static let response = """
        Fixed Quit so Squeak fully exits.
        Your chats and settings are preserved.
        To verify, quit Squeak and reopen it.
        """

    /// The pill's height as laid out on a screen `screenHeight` tall, with the field at `fieldText`'s
    /// size, both disclosures open when `expanded`. Hosts it for a moment and lets layout settle, so
    /// call it from a capture run (main thread) and compare with `QuickLayout.windowHeight` plus the
    /// pill's own chrome: it must never exceed `screenHeight`.
    static func fittingHeight(model: AppModel, long: Bool, expanded: Bool, screenHeight: CGFloat, fieldText: String = "") -> CGFloat {
        let s = state(model: model, long: long)
        s.screenHeight = screenHeight
        s.text = fieldText
        s.context.expanded = expanded
        s.context.showEarlier = expanded
        let host = NSHostingView(rootView: QuickComposerView(close: {}).environment(model).environment(s))
        host.frame = NSRect(x: 0, y: 0, width: QuickComposerView.windowWidth, height: screenHeight)
        for _ in 0..<5 {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        return host.fittingSize.height
    }

    static func state(model: AppModel, long: Bool = false) -> QuickState {
        let state = QuickState()
        guard let session = model.sessions.first(where: model.canSend) ?? model.sessions.first else { return state }
        state.prepare(model: model, explicit: session.key)
        let now = Date()
        let text = long ? Array(repeating: response, count: 12).joined(separator: "\n\n") : response
        state.context.preview(
            key: session.key,
            anchor: NotificationAnchor(eventId: "capture", kind: .finished, at: now.addingTimeInterval(-60)),
            content: NotificationContextContent(
                confidence: .exact,
                request: ChatMessage(id: "u", role: .user, text: "Make Quit close the app for real."),
                earlier: [ChatMessage(id: "a0", role: .assistant, text: "Looking at the menu's Quit action.")],
                response: ChatMessage(id: "a1", role: .assistant, text: text, at: now.addingTimeInterval(-60))))
        return state
    }
}
