import Foundation
import Testing
@testable import SqueakMacCore

struct RoomHandoffTextTests {
    private func note(to: String? = "Dot", body: String, summary: String? = nil, fullBody: String? = nil, from: String = "Quill") -> RoomHandoff {
        RoomHandoff(fromSessionId: "s1", from: from, agent: nil, to: to, body: body, summary: summary, fullBody: fullBody)
    }

    @Test func aSummaryIsTheLineAndTheWholeMessageWaitsBehindADisclosure() {
        let n = note(body: "@Dot the global shortcuts moved, a very long message follows.", summary: "Heads-up: the shortcuts moved; fold them into the site rebuild.",
                     fullBody: "the global shortcuts moved, a very long message follows.")
        #expect(n.line == "Heads-up: the shortcuts moved; fold them into the site rebuild.")
        #expect(n.mention == "@Dot")
        #expect(n.fullMessage == "the global shortcuts moved, a very long message follows.")
        #expect(RoomHandoff.disclosureLabel(open: false) == "Show full message")
    }

    @Test func withNoSummaryTheLineIsTheFirstTwoSentencesCutAtAWordEnd() {
        let n = note(body: "Rename the tabs. Then ship it. And after that write the docs for all of it.")
        #expect(n.line == "Rename the tabs. Then ship it.")
        let long = note(body: String(repeating: "alpha beta gamma ", count: 40))
        #expect(long.line.count <= RoomHandoff.lineMax)
        #expect(long.line.hasSuffix("\u{2026}"))
        #expect(!long.line.dropLast().hasSuffix("gam") && !long.line.dropLast().hasSuffix("alp"))
    }

    @Test func aShortNoteHasNothingMoreToShow() {
        #expect(note(body: "@Dot rename the tabs").fullMessage == nil)
        #expect(note(body: "@Dot rename the tabs", summary: "Rename the tabs.").fullMessage == "rename the tabs")
    }

    @Test func noDigitEverShowsInADuckName() {
        let n = note(to: "Dot 2", body: "hi", from: "Quill 2")
        #expect(n.senderName == "Quill")
        #expect(n.mention == "@Dot")
        #expect(n.spoken == "Quill to Dot: hi")
        #expect(RoomDuckName.plain("Dot") == "Dot")
        #expect(RoomDuckName.plain("7") == "7")
        #expect(note(to: nil, body: "x").mention == nil)
    }

    @Test func newFieldsDecodeLeniently() throws {
        let full = Data(#"{"seq":1,"id":"a","author":{"kind":"agent","name":"Quill"},"text":"t","at":5,"summary":"S","fullBody":"All"}"#.utf8)
        let p = try JSONDecoder().decode(RoomPost.self, from: full)
        #expect(p.summary == "S" && p.fullBody == "All")
        let odd = Data(#"{"seq":1,"id":"a","author":{"kind":"agent","name":"Quill"},"text":"t","at":5,"summary":7,"fullBody":""}"#.utf8)
        let q = try JSONDecoder().decode(RoomPost.self, from: odd)
        #expect(q.summary == nil && q.fullBody == nil)
    }
}
