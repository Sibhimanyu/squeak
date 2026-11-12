import Foundation
import Testing
@testable import SqueakMacCore

// Rows recorded from a real Squeak chat (native.db, scrubbed): a turn ran from 06:07:26 (seq 298921), the person steered at
// 06:08:47 (298953, `steered`), Claude ended the old turn with a `result` two seconds later (298956) and took the steer in
// as the SDK's next turn (298958, helper under it) to 06:11:00 (298989). One piece of work: it must be one visual turn.

private func rows(upTo last: Int = .max) throws -> [NativeMessage] {
    let url = try #require(Bundle.module.url(forResource: "messages-claude-steer-chain", withExtension: "json", subdirectory: "native"))
    return try JSONDecoder().decode([NativeMessage].self, from: Data(contentsOf: url)).filter { $0.seq <= last }
}

struct NativeSteerChainTests {
    @Test func theWholeChainIsOneVisualTurn() throws {
        let all = try rows()
        #expect(NativeTranscript.turnStartIndices(all).count == 1)
        #expect(NativeTranscript.currentTurn(all)?.first?.seq == 298921)
        let mapped = NativeTranscript.map(all)
        #expect(Set(mapped.messages.compactMap(\.turnId)) == ["t298921"])
        #expect(mapped.turnSteps.keys.filter { $0 != NativeTranscript.headTurn } == ["t298921"])
    }

    @Test func theSteerCardSitsInlineWhereItWasSent() throws {
        let ids = NativeTranscript.map(try rows()).messages.map(\.id)
        let steer = try #require(ids.firstIndex(of: "native-298953"))
        let before = try #require(ids.firstIndex(of: "native-298932"))
        let after = try #require(ids.firstIndex(of: "native-298955"))
        #expect(before < steer && steer < after)
        let m = try #require(NativeTranscript.map(try rows()).messages.first { $0.id == "native-298953" })
        #expect(m.steered == true && m.turnId == "t298921" && !NativeTranscript.startsTurn(m))
        #expect(ImageAttachments.split(m.text).paths.count == 1)
    }

    @Test func nothingFoldsUntilTheChainEndsThenItIsOneFold() throws {
        let messages = NativeTranscript.map(try rows()).messages
        let mapped = NativeTranscript.map(try rows())
        let table = messages.map { (turnId: $0.turnId, isAgent: $0.role == .assistant) }
        // Mid-chain, after the old turn's result and while the steer is taken in: the newest turn draws live, no fold.
        let mid = TurnFolding.folds(rows: table, newestTurn: "t298921", working: true, turnWork: mapped.turnSteps, activity: [])
        #expect(mid.isEmpty)
        // Finished: a single fold for everything, before the first reply.
        let done = TurnFolding.folds(rows: table, newestTurn: "t298921", working: false, turnWork: mapped.turnSteps, activity: [])
        #expect(done.count == 1)
        let first = try #require(messages.firstIndex { $0.role == .assistant })
        #expect(done[first]?.id == "t298921")
        let steps = try #require(done[first]?.steps)
        #expect(steps.contains { $0.text.contains("Agent") || $0.kind == "tool" })
    }

    @Test func theClockStartsWhereTheWorkStarted() throws {
        let messages = NativeTranscript.map(try rows()).messages
        let start = try #require(TurnFolding.turnStart(messages: messages, steps: []))
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        #expect(start == f.date(from: "2026-11-12T06:07:26.257Z"))
    }

    @Test func aSteerWrittenJustAfterTheResultStillJoinsTheChain() throws {
        var all = try rows(upTo: 298952)
        let ended = Date(timeIntervalSince1970: 2_000_000_000)
        all.append(NativeMessage(seq: 298956, role: "agent", kind: "result/success", payload: .object([:]), createdAt: ended))
        all.append(
            NativeMessage(seq: 298957, role: "user", kind: "user/text", payload: .object(["text": .string("late steer"), "steered": .bool(true)]),
                          createdAt: ended.addingTimeInterval(1)))
        #expect(NativeTranscript.turnStartIndices(all).count == 1)
        #expect(NativeTranscript.map(all).messages.last?.turnId == "t298921")
        // Well after the result it is a new message to a finished chat.
        all[all.count - 1].createdAt = ended.addingTimeInterval(60)
        #expect(NativeTranscript.turnStartIndices(all).count == 2)
        #expect(NativeTranscript.map(all).messages.last?.turnId == "t298957")
    }

    @Test func stepsAreOrderedInTimeAroundTheSteerCard() throws {
        let all = try rows()
        let mapped = NativeTranscript.map(all)
        let steer = try #require(mapped.messages.first { $0.id == "native-298953" })
        let at = try #require(steer.at)
        let runs = TurnFolding.split(steps: try #require(mapped.turnSteps["t298921"]), at: [at])
        #expect(runs.count == 2)
        let time = { (seq: Int) in all.first { $0.seq == seq }?.createdAt }
        // Steps up to seq 298952 are above the card, those after Claude took it in (298958) are below, none the other way.
        #expect(runs[0].contains { $0.at == time(298952) || $0.at == time(298949) })
        #expect(runs[0].allSatisfy { ($0.at ?? .distantPast) < at })
        #expect(runs[1].contains { $0.at == time(298960) })
        #expect(runs[1].allSatisfy { ($0.at ?? .distantFuture) >= at })
        #expect(runs[0].count + runs[1].count == mapped.turnSteps["t298921"]?.count)
        // No steer, no split; two steers, three runs.
        #expect(TurnFolding.split(steps: runs[0], at: []).count == 1)
        #expect(TurnFolding.split(steps: runs[0] + runs[1], at: [at, at.addingTimeInterval(60)]).count == 3)
    }
}
