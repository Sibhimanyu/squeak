import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Local sends against the transcript")
struct LocalSendTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func host(_ id: String, _ role: MessageRole, _ text: String, at offset: TimeInterval) -> ChatMessage {
        ChatMessage(id: id, role: role, text: text, at: t0.addingTimeInterval(offset), turnId: "t")
    }

    /// A broker focused on one chat whose transcript is `transcript`, with the clock at `t0`.
    func broker(_ transcript: [ChatMessage], state: SessionState = .finished) async -> (Broker, FakeAdapter, FakeClock, SessionKey) {
        let s = makeSession("c1", state: state)
        let a = FakeAdapter(sessions: [s])
        await a.setTranscript(transcript)
        let clock = FakeClock(start: t0)
        let b = Broker(adapters: [a], clock: clock)
        await b.refresh()
        await b.setFocused(s.key)
        await b.refreshTranscript()
        return (b, a, clock, s.key)
    }

    @Test func aSendTheTranscriptShowsWithAttachmentMarkersIsConfirmedNotDrawnTwice() async {
        let (b, a, _, key) = await broker([host("old", .assistant, "earlier", at: -60)])
        await b.send("look at this", to: key)
        // The transcript's copy carries an attachment marker, and the agent has already answered.
        await a.setTranscript([
            host("old", .assistant, "earlier", at: -60),
            host("u1", .user, "look at this [Image #1]", at: 1),
            host("a1", .assistant, "I see it.", at: 20),
        ])
        await b.refreshTranscript()
        let shown = await b.messages(for: key)
        #expect(shown.map(\.id) == ["old", "u1", "a1"])
        #expect(shown[1].state == .confirmed)
        // The prompt is never after the reply, and no "Starting…" follows it.
        #expect(!ChatTimeline.isWorking(messages: shown, state: .finished, now: t0.addingTimeInterval(25)))
    }

    @Test func aDeliveredSendTheTranscriptMovedPastIsDroppedOnceTheAgentIsDone() async {
        let (b, a, _, key) = await broker([host("old", .assistant, "earlier", at: -60)])
        await b.send("text the host stored differently", to: key)
        #expect(await b.messages(for: key).last?.text == "text the host stored differently")
        await a.setTranscript([
            host("old", .assistant, "earlier", at: -60),
            host("u1", .user, "something else entirely", at: 1),
            host("a1", .assistant, "done", at: 20),
        ])
        await b.refreshTranscript()
        #expect(await b.messages(for: key).map(\.id) == ["old", "u1", "a1"])
    }

    @Test func aSendThatWasNotDeliveredSitsWhereItWasSentNotAfterTheReply() async {
        let (b, a, _, key) = await broker([host("old", .assistant, "earlier", at: -60)])
        await a.setSendResult(.refused(reason: "busy"))
        await b.send("try this", to: key)
        await a.setTranscript([host("old", .assistant, "earlier", at: -60), host("a1", .assistant, "later reply", at: 20)])
        await b.refreshTranscript()
        let shown = await b.messages(for: key)
        #expect(shown.map(\.text) == ["earlier", "try this", "later reply"])
    }

    @Test func whileTheAgentWorksAQueuedSendWaitsAtTheEnd() async {
        let (b, a, _, key) = await broker([host("a0", .assistant, "step", at: -5)], state: .working)
        await b.send("next", to: key)
        await a.setTranscript([host("a0", .assistant, "step", at: -5), host("a1", .assistant, "another step", at: 3)])
        await b.refreshTranscript()
        #expect(await b.messages(for: key).map(\.text) == ["step", "another step", "next"])
    }

    @Test func aSettledDeliveredSendExpires() async {
        let (b, _, clock, key) = await broker([])
        await b.send("never shown", to: key)
        #expect(await b.messages(for: key).count == 1)
        clock.advance(Broker.settleAfter + 1)
        #expect(await b.messages(for: key).isEmpty)
    }

    @Test func aFailedSendLingersForTheFixThenGoes() async {
        let (b, a, clock, key) = await broker([])
        await a.setSendResult(.refused(reason: "busy"))
        await b.send("again", to: key)
        clock.advance(Broker.settleAfter + 1)
        #expect(await b.messages(for: key).count == 1)
        clock.advance(Broker.failureLinger)
        #expect(await b.messages(for: key).isEmpty)
    }

    @Test func aSendToAChatNotOnScreenIsStillConfirmed() async {
        let one = makeSession("c1", state: .finished), two = makeSession("c2", state: .finished)
        let a = FakeAdapter(sessions: [one, two])
        await a.setTranscript([])
        let clock = FakeClock(start: t0)
        let b = Broker(adapters: [a], clock: clock)
        await b.refresh()
        await b.setFocused(two.key)
        await b.send("hello c1", to: one.key)
        #expect(await b.localState(clientId: await b.messages(for: one.key)[0].clientId!, in: one.key) == .accepted(via: "conductor"))
        await a.setTranscript([host("u", .user, "hello c1", at: 1), host("a", .assistant, "hi", at: 5)])
        await b.refresh() // the poll, with another chat focused
        let shown = await b.messages(for: one.key)
        #expect(shown.map(\.id) == ["u", "a"] && shown[0].state == .confirmed)
    }

    @Test func aCachedCopyDoesNotCarryASendAfterTheStaleReply() async {
        let cache = EncryptedCache(configuration: .init(directory: tempDirectory()), keyStore: MemoryKeyStore())
        let s = makeSession("c1", state: .finished)
        let a = FakeAdapter(sessions: [s])
        await a.setTranscript([host("a0", .assistant, "cached reply", at: -30)])
        let first = Broker(adapters: [a], clock: FakeClock(start: t0), cache: cache)
        await first.refresh()
        await first.setFocused(s.key)
        await first.refreshTranscript()

        let clock = FakeClock(start: t0)
        let b = Broker(adapters: [a], clock: clock, cache: cache)
        await b.restoreFromCache()
        await b.refresh()
        await b.send("sent just now", to: s.key)
        // Brand new: drawn, so the person sees what they sent.
        #expect(await b.messages(for: s.key).map(\.text) == ["cached reply", "sent just now"])
        // Before any live read, it is not carried after a copy that may be stale.
        clock.advance(10)
        #expect(await b.messages(for: s.key).map(\.text) == ["cached reply"])
        await b.setFocused(s.key)
        await b.refreshTranscript()
        #expect(await b.messages(for: s.key).count == 2)
    }
}

@Suite("Receipts and sent-text matching")
struct ReceiptTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func me(_ state: MessageState?) -> ChatMessage { ChatMessage(id: "u", role: .user, text: "go", at: now, state: state) }
    let reply = ChatMessage(id: "a", role: .assistant, text: "done")

    @Test func readThenTurnEnded() {
        #expect(ChatTimeline.receipt(messages: [me(.confirmed)], state: .working)?.receipt == .read)
        #expect(ChatTimeline.receipt(messages: [me(.confirmed), reply], state: .working)?.receipt == .read)
        #expect(ChatTimeline.receipt(messages: [me(.confirmed), reply], state: .finished)?.receipt == .turnEnded)
        #expect(ChatTimeline.receipt(messages: [me(.confirmed), reply], state: .finished)?.id == "u")
        #expect(ChatTimeline.receipt(messages: [me(.accepted(via: "x", delivery: .steered))], state: .working) == nil)
        #expect(ChatTimeline.receipt(messages: [me(nil)], state: .finished) == nil)
        #expect(ChatTimeline.Receipt.read.line(agent: "Claude") == "Read by Claude")
        #expect(ChatTimeline.Receipt.turnEnded.line(agent: "Claude") == "Turn ended")
    }

    @Test func onlyTheNewestUserMessageCarriesIt() {
        var older = me(.confirmed)
        older.id = "older"
        let newer = me(.confirmed)
        #expect(ChatTimeline.receipt(messages: [older, reply, newer], state: .finished)?.id == "u")
    }

    @Test func matchingToleratesMarkersWhitespaceAndClipping() {
        #expect(SentTextMatch.matches(sent: "fix it", host: "  fix   it \n"))
        #expect(SentTextMatch.matches(sent: "look at this", host: "look at this [Image #1]"))
        #expect(SentTextMatch.matches(sent: "[Image #2] look at this", host: "look at this"))
        let long = String(repeating: "word ", count: 80)
        #expect(SentTextMatch.matches(sent: long, host: String(long.prefix(120)) + "…"))
        #expect(!SentTextMatch.matches(sent: "fix it", host: "fix the other thing"))
        #expect(!SentTextMatch.matches(sent: "ok", host: "okay then, let me look"))
        #expect(!SentTextMatch.matches(sent: "[Image #1]", host: "[Image #2]"))
    }
}

@Suite("Daemon paging and answers")
struct DaemonPagingTests {
    let base = URL(string: "http://127.0.0.1:8477")!

    @Test func beforeIsSentOnlyAsDigitsAndTheCursorsComeBack() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/session/t1/transcript", """
        {"messages":[{"id":"m1","role":"user","text":"hi","cursor":"41"}],"complete":false,"nextBefore":"41"}
        """)
        let client = DaemonClient(baseURL: base, transport: t, tokenProvider: { "tok" })
        let adapter = ConductorDaemonAdapter(client: client)
        let session = makeSession("t1")
        let page = try await adapter.transcriptPage(for: session, limit: 20, before: "99")
        #expect(page.messages.first?.cursor == "41" && page.nextBefore == "41" && !page.complete)
        _ = try await adapter.transcriptPage(for: session, limit: 20, before: "9;drop")
        let queries = await t.requests.map { $0.url.query }
        #expect(queries == ["limit=20&before=99", "limit=20"])
    }

    @Test func aReplyNamesTheTurnItAnswers() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/session/t1/reply", #"{"status":"started","via":"terminal"}"#)
        let client = DaemonClient(baseURL: base, transport: t, tokenProvider: { "tok" })
        _ = await client.reply(replyTarget: "t1", text: "A", mode: .queue, answersTurn: "turn-7")
        _ = await client.reply(replyTarget: "t1", text: "B")
        let bodies = await t.requests.map { try? JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: String] }
        #expect(bodies[0] == ["text": "A", "answersTurn": "turn-7"])
        #expect(bodies[1] == ["text": "B"])
    }
}
