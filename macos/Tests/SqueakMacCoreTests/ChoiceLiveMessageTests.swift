import Testing
@testable import SqueakMacCore

@Suite struct ChoiceLiveMessageTests {
    static let text = "The question about hidden windows is still open:\n\nWhich way should we go?\nA) Green edge on windows the class can see, plus \"Class sees this\" / \"Only you\" labels where you choose (recommended)\nB) Your idea: hidden windows go semi-transparent\nC) Just the clearer labels on the speaker view, no edge\nD) Let's talk it through more first"

    @Test func fourOptionsWithRecommended() {
        let l = ChoiceLayout.make(Self.text)
        #expect(l?.cards.count == 4)
        #expect(l?.cards.first?.isRecommended == true)
    }

    @Test func twoLineOptionA() {
        let t = "Which way should we go?\nA) Green edge on windows the class can see\n   plus labels where you choose (recommended)\nB) Hidden windows go semi-transparent\nC) Just the labels\nD) Talk it through"
        let l = ChoiceLayout.make(t)
        #expect(l?.cards.count == 4)
        #expect(l?.cards.first?.isRecommended == true)
    }
}
