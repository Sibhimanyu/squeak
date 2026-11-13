import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct FocusModelTests {
    @Test func cmdTIsAlwaysAChatTabAndTerminalTabsHaveTheirOwnChord() {
        for r in [FocusRegion.composer, .transcript, .terminal, .fileViewer, .review, .sidebar] {
            #expect(ShortcutFocus.action(.newTab, in: r) == .newThread)
            #expect(ShortcutFocus.action(.newTerminalTab, in: r) == .newTerminal)
        }
        #expect(ShortcutFocus.action(.newTab, in: .quickComposer) == .passThrough)
        #expect(ShortcutFocus.action(.newTerminalTab, in: .quickComposer) == .passThrough)
        #expect(ShortcutFocus.newTerminalChord == "⌃⇧`")
    }

    @Test func collapsingTheTerminalMovesKeysToTheComposer() {
        #expect(ShortcutFocus.focusAfterCollapse(from: .terminal) == .composer)
        for r in [FocusRegion.composer, .transcript, .fileViewer, .review, .sidebar] {
            #expect(ShortcutFocus.focusAfterCollapse(from: r) == .keep)
        }
    }

    @Test func dividerTokens() {
        #expect(Tokens.Divider.thickness == 1)
        #expect((6...8).contains(Tokens.Divider.hit))
    }

    @Test func collapsedTerminalNeverHoldsFocus() {
        #expect(FocusRegion.terminal.effective(terminalOpen: false) == .composer)
        #expect(ShortcutFocus.action(.newTab, in: .terminal, terminalOpen: false) == .newThread)
        #expect(ShortcutFocus.action(.close, in: .terminal, terminalOpen: false) == .closeChatTab)
        #expect(ShortcutFocus.terminalTitleHint(in: .terminal, terminalOpen: false) == nil)
    }

    @Test func closeNeverReachesAChatFromTheTerminal() {
        #expect(ShortcutFocus.action(.close, in: .terminal) == .closeTerminalTab)
        #expect(ShortcutFocus.action(.close, in: .fileViewer) == .closeFileTab)
        #expect(ShortcutFocus.action(.close, in: .review) == .closeReview)
        #expect(ShortcutFocus.action(.close, in: .composer) == .closeChatTab)
        #expect(ShortcutFocus.action(.close, in: .quickComposer) == .passThrough)
    }

    @Test func otherChords() {
        #expect(ShortcutFocus.action(.palette, in: .terminal) == .clearTerminal)
        #expect(ShortcutFocus.action(.palette, in: .composer) == .openPalette)
        #expect(ShortcutFocus.action(.focusComposer, in: .terminal) == .focusComposer)
        #expect(ShortcutFocus.action(.leaveTerminal, in: .terminal) == .focusComposer)
        #expect(ShortcutFocus.action(.leaveTerminal, in: .composer) == .passThrough)
        #expect(ShortcutFocus.action(.escape, in: .terminal) == .passThrough)
        #expect(ShortcutFocus.action(.session(3), in: .terminal) == .openSession(3))
        #expect(ShortcutFocus.action(.session(0), in: .composer) == .passThrough)
        #expect(ShortcutFocus.action(.back, in: .fileViewer) == .passThrough)
        #expect(ShortcutFocus.action(.back, in: .terminal) == .navigateBack)
        #expect(ShortcutFocus.action(.reopenTab, in: .terminal) == .reopenChatTab)
        for c in [FocusChord.newTab, .newTerminalTab, .close, .palette, .focusComposer, .session(1), .back, .reopenTab] {
            #expect(ShortcutFocus.action(c, in: .quickComposer) == .passThrough)
        }
    }

    @Test func menuLabelsFollowFocus() {
        let chat = ShortcutFocus.newMenu(in: .composer, terminalOpen: true)
        #expect(chat.thread.chord == "⌘T" && chat.terminal.chord == "⌃⇧`")
        let term = ShortcutFocus.newMenu(in: .terminal, terminalOpen: true)
        #expect(term.terminal.chord == "⌃⇧`" && term.thread.chord == "⌘T")
        #expect(term.thread.title == "New Thread" && term.terminal.title == "New Terminal")
        #expect(ShortcutFocus.newMenu(in: .terminal, terminalOpen: false).thread.chord == "⌘T")
        #expect(ShortcutFocus.closeTitle(in: .terminal, terminalOpen: true) == "Close Terminal")
        #expect(ShortcutFocus.closeTitle(in: .composer, terminalOpen: true) == "Close Tab")
        #expect(ShortcutFocus.newThreadHint(in: .composer, terminalOpen: true) == "New thread  ⌘T")
        #expect(ShortcutFocus.newThreadHint(in: .terminal, terminalOpen: true) == "New thread  ⌘T")
        #expect(ShortcutFocus.newTerminalHint(in: .terminal, terminalOpen: true) == "New terminal  ⌃⇧`")
        #expect(ShortcutFocus.terminalTitleHint(in: .terminal, terminalOpen: true) == "⌃⇧` New terminal · ⌘W Close terminal")
        #expect(ShortcutFocus.terminalTitleHint(in: .composer, terminalOpen: true) == nil)
    }

    @Test func registryStaysSound() { #expect(ShortcutRegistry.duplicates().isEmpty) }
}
