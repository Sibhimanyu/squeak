import Foundation
import Testing
@testable import SqueakMacCore

// Rows recorded from a real Squeak chat (native.db, scrubbed and clipped): the agent ended a turn with lettered options,
// the person answered "A" (seq 298751), the agent started a foreground helper (298755), and 2 s later the person typed
// another message that was steered into the same running turn (298758). The steered message was read as a new turn, so
// the live feed lost the answer's thinking and helper row for as long as the helper ran.

private func rows() throws -> [NativeMessage] {
    let url = try #require(Bundle.module.url(forResource: "messages-claude-answer-subagent", withExtension: "json", subdirectory: "native"))
    return try JSONDecoder().decode([NativeMessage].self, from: Data(contentsOf: url))
}

struct NativeAnswerTurnTests {
    @Test func theAnswerStartsTheTurn() throws {
        let all = try rows()
        let turn = try #require(NativeTranscript.currentTurn(Array(all.filter { $0.seq <= 298757 })))
        #expect(turn.first?.seq == 298751)
        let steps = NativeTranscript.map(turn).steps
        #expect(steps.contains { $0.kind == "tool" && $0.text.hasPrefix("Agent") || $0.kind == "tool" && $0.text.contains("Single Add") })
    }

    @Test func aSteeredMessageStaysInTheRunningTurn() throws {
        let all = try rows()
        #expect(all.contains { $0.seq == 298758 && $0.payload["steered"]?.bool == true })
        let turn = try #require(NativeTranscript.currentTurn(all))
        #expect(turn.first?.seq == 298751)
        let mapped = NativeTranscript.map(turn)
        #expect(mapped.steps.contains { $0.kind == "tool" })
        let steer = try #require(mapped.messages.first { $0.id == "native-298758" })
        #expect(steer.turnId == "t298751")
        #expect(NativeTranscript.startsTurn(steer) == false)
        #expect(mapped.turnSteps["t298751"]?.contains { $0.kind == "tool" } == true)
        #expect(mapped.turnSteps["t298758"] == nil)
    }

    @Test func theLiveClockStartsAtTheAnswerNotTheSteer() throws {
        let all = try rows()
        let messages = NativeTranscript.map(NativeTranscript.currentTurn(all) ?? []).messages
        let answer = try #require(messages.first { $0.id == "native-298751" })
        #expect(TurnFolding.turnStart(messages: messages, steps: []) == answer.at)
    }

    @Test func aSteerByInterruptAfterTheTurnEndedIsANewTurn() throws {
        var all = try rows().filter { $0.seq <= 298757 }
        all.append(NativeMessage(seq: 298800, role: "agent", kind: "error", payload: .object(["content": .string("aborted by user")])))
        all.append(NativeMessage(seq: 298801, role: "user", kind: "user/text", payload: .object(["text": .string("do this instead"), "steered": .bool(true)])))
        let turn = try #require(NativeTranscript.currentTurn(all))
        #expect(turn.first?.seq == 298801)
        #expect(NativeTranscript.map(all).messages.last?.turnId == "t298801")
    }

    @Test func aPageNeverStartsAtASteeredMessage() throws {
        let chat = NativeTranscript.map(try rows()).messages
        let at = try #require(chat.firstIndex { $0.id == "native-298758" })
        let start = try #require(NativeAdapter.pageStart(chat, limit: chat.count - at, exhausted: true))
        #expect(chat[start].id != "native-298758")
    }
}
