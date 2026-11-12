import Foundation
import Testing
@testable import SqueakMacCore

// What a finished turn keeps after a restart: its steps, filed under the turn its messages carry.

private func row(_ seq: Int, _ role: String, _ kind: String, _ json: String) -> NativeMessage {
    NativeMessage(seq: seq, role: role, kind: kind, payload: NativeJSON.parse(json)!, createdAt: Date(timeIntervalSince1970: 1_800_000_000 + Double(seq) * 30))
}

private func claude(_ seq: Int, _ block: String) -> NativeMessage {
    row(seq, "agent", "assistant", #"{"type":"assistant","message":{"id":"m\#(seq)","content":[\#(block)]}}"#)
}

/// Two Claude turns, then a Codex-shaped third, with a user row that starts each.
private func chat() -> [NativeMessage] {
    [
        row(1, "user", "user/text", #"{"text":"first"}"#),
        claude(2, #"{"type":"thinking","thinking":"Plan it."}"#),
        claude(3, #"{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}"#),
        row(4, "agent", "user", #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a\nb"}]}}"#),
        claude(5, #"{"type":"text","text":"Done one."}"#),
        row(6, "agent", "system/api_retry", #"{"attempt":1,"max_retries":3,"retry_delay_ms":1000}"#),
        row(7, "user", "user/text", #"{"text":"second"}"#),
        claude(8, #"{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/w/a.ts"}}"#),
        claude(9, #"{"type":"text","text":"Done two."}"#),
        row(10, "user", "user/text", #"{"text":"third"}"#),
        row(11, "agent", "item/commandExecution", #"{"id":"c1","command":"/bin/bash -lc 'npm test'","exitCode":0,"aggregatedOutput":"ok"}"#),
        row(12, "agent", "item/agentMessage", #"{"text":"Done three."}"#),
    ]
}

@Suite struct PastTurnsTests {
    @Test func stepsAreFiledUnderTheirOwnTurn() {
        let m = NativeTranscript.map(chat())
        #expect(Set(m.turnSteps.keys) == ["t1", "t7", "t10"])
        #expect(m.turnSteps["t1"]?.map(\.kind) == ["you", "thinking", "tool", "note"])
        #expect(m.turnSteps["t7"]?.map(\.text) == ["second", "Read a.ts", "Done two."])
        #expect(m.turnSteps["t10"]?.compactMap { $0.kind == "tool" ? $0.text : nil } == ["npm test"])
    }

    @Test func aStepKeepsWhatOpensUnderIt() {
        let m = NativeTranscript.map(chat())
        // The result row came after the call: its output is still on the step.
        let run = m.turnSteps["t1"]?.first { $0.toolId == "t1" }
        #expect(run?.detail == .output(command: "ls", tail: ["a", "b"], succeeded: true))
        #expect(m.turnSteps["t10"]?.first { $0.toolId == "c1" }?.detail == .output(command: "npm test", tail: ["ok"], succeeded: true))
    }

    @Test func theLiveRetryLineIsNotPartOfAnyRecord() {
        let m = NativeTranscript.map(chat())
        #expect(!(m.turnSteps.values.joined()).contains { $0.kind == "retry" })
    }

    @Test func rowsThatBeginMidTurnFileTheirStepsApart() {
        let m = NativeTranscript.map(Array(chat().dropFirst(2).prefix(4)))
        #expect(m.turnSteps[NativeTranscript.headTurn]?.map(\.kind) == ["tool", "note"])
        #expect(m.turnSteps["t1"] == nil)
    }

    @Test func aPageStartsAtAPersonsMessageSoNoTurnIsSplit() {
        let msgs = NativeTranscript.map(chat()).messages  // user, a, user, a, user, a
        // Asking for 3 would start at the second user message's answer: it moves back to the person's message.
        #expect(NativeAdapter.pageStart(msgs, limit: 3, exhausted: true) == 2)
        #expect(NativeAdapter.pageStart(msgs, limit: 4, exhausted: true) == 2)
        #expect(NativeAdapter.pageStart(msgs, limit: 6, exhausted: true) == 0)
        // Too few rows read to know: more are needed unless the start of the chat was reached.
        #expect(NativeAdapter.pageStart(msgs, limit: 6, exhausted: false) == nil)
        #expect(NativeAdapter.pageStart(Array(msgs.dropFirst()), limit: 5, exhausted: false) == nil)
    }

    @Test func aPageCarriesOnlyItsOwnTurns() {
        let m = NativeTranscript.map(chat())
        let page = NativeAdapter.page(m, from: 2, exhausted: true, cursor: nil)
        #expect(Set(page.turns.keys) == ["t7", "t10"])
        #expect(page.nextBefore == "7")
        #expect(NativeAdapter.page(m, from: 0, exhausted: true, cursor: nil).nextBefore == nil)
    }

    @Test func foldTitleSaysHowLongAndHowMany() {
        let t = Date(timeIntervalSince1970: 1_000)
        let steps = [ActivityStep(kind: "you", text: "go", at: t), ActivityStep(kind: "tool", text: "Read a.ts", at: t.addingTimeInterval(124))]
        #expect(TurnFolding.foldedTitle(steps: steps, items: 14) == "Worked for 2m 4s · 14 steps")
        #expect(TurnFolding.foldedTitle(steps: [ActivityStep(kind: "tool", text: "Read a.ts")], items: 1) == "Worked · 1 step")
        #expect(TurnFolding.foldedTitle(steps: steps, items: 0) == nil)
    }

    @Test func finishedTurnFoldsEveryStepAndSkipsTheTracker() {
        let steps = [
            ActivityStep(kind: "you", text: "go"), ActivityStep(kind: "thinking", text: "Plan."),
            ActivityStep(kind: "tool", text: "Read a.ts"), ActivityStep(kind: "progress", text: "x"), ActivityStep(kind: "note", text: "hi"),
        ]
        let block = TurnFolding.finished(steps: steps)
        #expect(block.folded.count == 2 && block.shown.isEmpty)
    }

    @Test func foldsSitBeforeEachTurnsFirstAgentMessage() {
        let rows: [(turnId: String?, isAgent: Bool)] = [("t1", false), ("t1", true), ("t1", true), ("t7", false), ("t7", true), ("t10", false), ("t10", true)]
        #expect(TurnFolding.foldAnchors(rows: rows) == [1: "t1", 4: "t7", 6: "t10"])
        #expect(TurnFolding.foldAnchors(rows: rows, skipping: "t10") == [1: "t1", 4: "t7"])
    }

    @Test func aPictureTokenSplitsIntoWordsAndAPath() {
        let text = "Look at this\n\n@⟦image-1.png⟧(.context%2Fattachments%2F4b3f3360%2Fimage-1.png)"
        let s = ImageAttachments.split(text)
        #expect(s.words == "Look at this")
        #expect(s.paths == [".context/attachments/4b3f3360/image-1.png"])
        let two = ImageAttachments.split(ImageAttachments.compose("", refs: [".context/a/image-1.png", ".context/a/image-2.jpg"]))
        #expect(two.words == "See the attached images." && two.paths == [".context/a/image-1.png", ".context/a/image-2.jpg"])
        #expect(ImageAttachments.split("plain @mention") == ("plain @mention", []))
    }
}
