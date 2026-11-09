import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct TurnFooterTests {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func msg(_ id: String, _ role: MessageRole, _ text: String, _ secs: Double?) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, at: secs.map { t0.addingTimeInterval($0) })
    }

    @Test func theLastAgentMessageOfEachFinishedTurnCarriesTheFooter() {
        let list = [msg("u1", .user, "go", 0), msg("a1", .assistant, "step", 10), msg("a2", .assistant, "done", 79),
                    msg("u2", .user, "more", 100), msg("a3", .assistant, "ok", 130)]
        let f = TurnFooters.make(list, working: false)
        #expect(Set(f.keys) == ["a2", "a3"])
        #expect(f["a2"]?.elapsed == 79 && f["a2"]?.turnText == "step\n\ndone")
        #expect(f["a3"]?.elapsed == 30)
    }

    @Test func theTurnBeingWorkedOnHasNoFooterYet() {
        let list = [msg("u1", .user, "go", 0), msg("a1", .assistant, "done", 5), msg("u2", .user, "again", 20), msg("a2", .assistant, "partial", 25)]
        #expect(Set(TurnFooters.make(list, working: true).keys) == ["a1"])
    }

    @Test func unknownTimesDropOnlyWhatTheyMust() {
        let f = TurnFooters.make([msg("a1", .assistant, "hi", 50)], working: false)["a1"]
        #expect(f?.elapsed == nil)
        #expect(f?.line(timeFormat: { _ in "4:03 PM" }) == "4:03 PM")
        let g = TurnFooter(elapsed: 79, at: t0, turnText: "")
        #expect(g.line(timeFormat: { _ in "4:03 PM" }) == "1m 19s · 4:03 PM")
        #expect(TurnFooter(elapsed: nil, at: nil, turnText: "").line(timeFormat: { _ in "x" }) == "")
    }

    @Test func aPersonsMessageWithNoReplyHasNoFooter() {
        #expect(TurnFooters.make([msg("u1", .user, "hello", 0)], working: false).isEmpty)
    }

    @Test func aStartedSubagentReadsAgent() {
        #expect(ToolCallLabel.preview("Start Extract the runtime").shownVerb == "Agent")
        #expect(ToolCallLabel.preview("Read store.ts").shownVerb == "Read")
    }
}
