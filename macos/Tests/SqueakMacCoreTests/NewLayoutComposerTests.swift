import Testing

@testable import SqueakMacCore

struct NewLayoutComposerTests {
    @Test func chipNamesTheHostDuckNotTheChatTitle() {
        let ducks = [PondDuck(id: "d1", name: "Pip", currentSessionId: "s1"), PondDuck(id: "d2", name: "Moss", currentSessionId: "s2")]
        #expect(ComposerChip.duckName(duckId: "d1", sessionId: "s9", ducks: ducks, chatTitle: "Fix the zoom bug") == "Pip")
        #expect(ComposerChip.duckName(duckId: "dX", sessionId: "s2", ducks: ducks, chatTitle: "Fix the zoom bug") == "Moss")
        #expect(ComposerChip.duckName(duckId: "d1", sessionId: "s1", ducks: nil, chatTitle: "Fix the zoom bug") == nil)
        #expect(ComposerChip.duckName(duckId: nil, sessionId: "s1", ducks: ducks, chatTitle: "Fix the zoom bug") == "Fix the zoom bug")
        #expect(ComposerChip.line(duck: "Pip", model: "Opus 5.5", effort: nil) == "Pip \u{00B7} Opus 5.5")
    }

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

    @Test func actionRowAlwaysReservesItsHeightAndStaysVisibleOnTheNewestReply() {
        #expect(MessageActionBarState.reservedHeight > 0)
        #expect(MessageActionBarState(isNewest: true).isVisible)
        #expect(MessageActionBarState(isNewest: true).opacity == 1)
        #expect(MessageActionBarState().opacity == 0)
    }

    @Test func newestReplyIsTheLastMessageWithAFooter() {
        func m(_ id: String) -> ChatMessage { ChatMessage(id: id, role: .assistant, text: id) }
        let f = TurnFooter(elapsed: 1, at: nil, turnText: "x")
        #expect(MessageActionBarState.newestID(in: [m("a"), m("b"), m("c")], footers: ["a": f, "b": f]) == "b")
        #expect(MessageActionBarState.newestID(in: [m("a")], footers: [:]) == nil)
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
