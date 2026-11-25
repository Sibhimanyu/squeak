import Testing

@testable import SqueakMacCore

struct NewLayoutComposerTests {
    @Test func actionBarIsHiddenAtRest() {
        let s = MessageActionBarState()
        #expect(!s.isVisible)
        #expect(s.opacity == 0)
    }

    @Test func actionBarShowsOnHoverKeyboardFocusOrOpenMenu() {
        #expect(MessageActionBarState(hovering: true).isVisible)
        #expect(MessageActionBarState(focusWithin: true).isVisible)
        #expect(MessageActionBarState(menuOpen: true).isVisible)
        #expect(MessageActionBarState(hovering: true, focusWithin: true).opacity == 1)
    }

    @Test func chipJoinsDuckModelAndEffort() {
        #expect(ComposerChip.line(duck: "Pip", model: "Opus 5.5", effort: "Medium") == "Pip \u{00B7} Opus 5.5 \u{00B7} Medium")
    }

    @Test func chipDropsUnknownPartsAndClipsLongNames() {
        #expect(ComposerChip.line(duck: nil, model: "Opus 5.5", effort: nil) == "Opus 5.5")
        #expect(ComposerChip.line(duck: "  ", model: nil, effort: nil) == "")
        let long = ComposerChip.line(duck: String(repeating: "a", count: 40), model: "M", effort: nil)
        #expect(long.hasPrefix(String(repeating: "a", count: 23) + "\u{2026} "))
        #expect(ComposerChip.line(duck: "First\nSecond", model: nil, effort: nil) == "First")
    }
}
