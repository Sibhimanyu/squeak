import Testing
@testable import SqueakMacCore

@Suite struct CardKeysTests {
    private func act(_ k: CardKeys.Key, _ c: CardKeys.Card, n: Int = 3, _ f: CardKeys.Focus = .none, text: Bool = false, busy: Bool = false) -> CardKeys.Action? {
        CardKeys.action(key: k, card: c, optionCount: n, focus: f, composerHasText: text, busy: busy)
    }

    @Test func approvalKeys() {
        #expect(act(.returnKey, .approval) == .allowOnce)
        #expect(act(.delete, .approval) == .deny)
        #expect(act(.digit(1), .approval) == nil)
    }

    @Test func planKeys() {
        #expect(act(.returnKey, .plan) == .approvePlan)
        #expect(act(.delete, .plan) == .keepPlanning)
    }

    @Test func questionDigits() {
        #expect(act(.digit(1), .question) == .answer(0))
        #expect(act(.digit(3), .question) == .answer(2))
        #expect(act(.digit(4), .question) == nil)
        #expect(act(.digit(0), .question) == .other)
        #expect(act(.returnKey, .question) == nil)
        #expect(act(.digit(9), .question, n: 12) == .answer(8))
    }

    @Test func emptyComposerStillCounts() {
        #expect(act(.returnKey, .approval, .composer, text: false) == .allowOnce)
        #expect(act(.digit(2), .question, .composer, text: false) == .answer(1))
    }

    @Test func wordsInTheComposerKeepTheirKeys() {
        #expect(act(.returnKey, .approval, .composer, text: true) == nil)
        #expect(act(.delete, .approval, .composer, text: true) == nil)
        #expect(act(.digit(1), .question, .composer, text: true) == nil)
    }

    @Test func otherFieldsAreNeverTheCards() {
        #expect(act(.returnKey, .approval, .otherField, text: false) == nil)
        #expect(act(.digit(1), .question, .otherField) == nil)
    }

    @Test func busyCardIgnoresKeys() {
        #expect(act(.returnKey, .approval, busy: true) == nil)
    }

    @Test func digitParsing() {
        #expect(CardKeys.digit("5") == .digit(5))
        #expect(CardKeys.digit("a") == nil)
        #expect(CardKeys.digit("12") == nil)
        #expect(CardKeys.digit(nil) == nil)
    }
}
