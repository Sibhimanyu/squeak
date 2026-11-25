import SqueakMacCore
import SwiftUI

/// The glue a composer needs around `ComposerPickerModel` and `ComposerPickerList`: the field handle, the caret, the popup's
/// direction, the keys and what picking does. The New duck page uses it; `ChatComposerBox` keeps its own copy of the same steps.
@MainActor @Observable
final class ComposerPickerDriver {
    let pick = ComposerPickerModel()
    @ObservationIgnored let handle = ComposerFieldHandle()
    var caret = 0
    var direction: SuggestionPlacement.Direction = .up

    /// Where the typed `@` or `/` sits (window x): the list opens from it.
    var triggerX: CGFloat? { pick.trigger.flatMap { handle.windowX(ofCharacterAt: $0.range.location) } }

    var keyHandler: ((ComposerPickerKey) -> Bool)? {
        pick.isOpen ? { [self] key in press(key) } : nil
    }

    private func press(_ key: ComposerPickerKey) -> Bool {
        switch key {
        case .up: pick.move(SuggestionPlacement.step(up: true, direction: direction))
        case .down: pick.move(SuggestionPlacement.step(up: false, direction: direction))
        case .accept:
            guard !pick.items.isEmpty else { return false }
            accept(pick.selected)
        case .escape: pick.dismiss()
        }
        return true
    }

    func accept(_ index: Int) {
        guard let c = pick.choice(at: index) else { return }
        handle.replace(c.range, with: c.text)
    }
}
