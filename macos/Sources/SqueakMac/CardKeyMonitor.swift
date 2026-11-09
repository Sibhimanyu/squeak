import AppKit
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10: the bare keys of a card that waits on you (↵ allow or approve, ⌫ deny or keep planning, 1–9
// answer, 0 your own). A bare key cannot be a key equivalent (the composer's text field would lose it), so a local
// monitor watches while a card is on screen and `CardKeys` (SqueakMacCore, tested) decides whether the key is the
// card's: only with focus outside any text field, or in the composer while it is empty.

extension View {
    /// Routes the bare card keys of this card to `perform` while it is on screen.
    func cardKeys(
        _ card: CardKeys.Card, optionCount: Int = 0, composerHasText: Bool, busy: Bool = false,
        perform: @escaping (CardKeys.Action) -> Void
    ) -> some View {
        background(CardKeyMonitor(card: card, optionCount: optionCount, composerHasText: composerHasText, busy: busy, perform: perform)
            .frame(width: 0, height: 0).accessibilityHidden(true))
    }
}

private struct CardKeyMonitor: NSViewRepresentable {
    let card: CardKeys.Card
    let optionCount: Int
    let composerHasText: Bool
    let busy: Bool
    let perform: (CardKeys.Action) -> Void

    func makeNSView(context: Context) -> Probe { Probe() }

    func updateNSView(_ view: Probe, context: Context) {
        view.card = card; view.optionCount = optionCount; view.composerHasText = composerHasText
        view.busy = busy; view.perform = perform
    }

    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.stop() }

    final class Probe: NSView {
        var card: CardKeys.Card = .approval
        var optionCount = 0
        var composerHasText = false
        var busy = false
        var perform: (CardKeys.Action) -> Void = { _ in }
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stop()
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, self.handle(event) else { return event }
                return nil
            }
        }

        func stop() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }


        /// True when the key was the card's.
        private func handle(_ event: NSEvent) -> Bool {
            guard let w = window, event.window === w, w.isKeyWindow, w.attachedSheet == nil, !event.isARepeat else { return false }
            guard event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else { return false }
            let key: CardKeys.Key
            switch event.keyCode {
            case 36, 76: key = .returnKey
            case 51: key = .delete
            default:
                guard let d = CardKeys.digit(event.charactersIgnoringModifiers) else { return false }
                key = d
            }
            let focus: CardKeys.Focus
            if let tv = w.firstResponder as? NSTextView {
                focus = tv is PlaceholderTextView ? .composer : (tv.isEditable ? .otherField : .none)
            } else {
                focus = .none
            }
            guard let action = CardKeys.action(
                key: key, card: card, optionCount: optionCount, focus: focus, composerHasText: composerHasText, busy: busy)
            else { return false }
            perform(action)
            return true
        }
    }
}
