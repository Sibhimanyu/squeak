import Foundation
import Testing
@testable import SqueakMacCore

private let toolResultRow = #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}"#

struct TranscriptPagingTests {
    /// One long turn: a prompt, `rows` tool rows, a reply.
    private func longTurn(_ f: ConductorFixture, rows: Int) throws {
        let env = ConductorFixture.envelope, t = ConductorFixture.text
        try f.addSession("s")
        try f.addMessage("s", role: "user", content: "the prompt of a long turn", sentAt: "2026-10-18T09:00:00.000Z", turn: "t1", id: "prompt")
        for i in 0..<rows {
            try f.addMessage("s", role: i % 2 == 0 ? "assistant" : "user",
                             content: i % 2 == 0 ? env([["type": "tool_use", "id": "x", "name": "Bash", "input": [:]]]) : toolResultRow,
                             sentAt: "2026-10-18T09:00:01.000Z", turn: "t1", id: "tool\(i)")
        }
        try f.addMessage("s", role: "assistant", content: env([t("All done.")]), sentAt: "2026-10-18T09:05:00.000Z", turn: "t1", id: "reply")
    }

    @Test func aSevenHundredRowTurnStillShowsItsOwnPrompt() throws {
        let f = try ConductorFixture()
        try longTurn(f, rows: 700)
        let (messages, complete) = try ConductorRegistry(database: f.database).transcript(sessionId: "s", limit: 50)
        #expect(messages.map(\.id) == ["prompt", "reply"])
        #expect(complete)
        // The prompt comes first, the reply after it.
        #expect(messages.map(\.role) == [.user, .assistant])
    }

    @Test func pagesStepBackByRowidAndEndAtTheStart() throws {
        let f = try ConductorFixture()
        try f.addSession("s")
        // Every row shares one timestamp: only the rowid orders them.
        for i in 0..<25 {
            try f.addMessage("s", role: "user", content: "m\(i)", sentAt: "2026-10-18T09:00:00.000Z", turn: "t", id: "m\(i)")
        }
        let registry = ConductorRegistry(database: f.database)
        let newest = try registry.transcriptPage(sessionId: "s", limit: 10, before: nil)
        #expect(newest.messages.map(\.id) == (15..<25).map { "m\($0)" })
        #expect(!newest.complete)
        let next = try #require(newest.nextBefore)
        #expect(String(next) == newest.messages[0].cursor)
        let older = try registry.transcriptPage(sessionId: "s", limit: 10, before: next)
        #expect(older.messages.map(\.id) == (5..<15).map { "m\($0)" })
        let last = try registry.transcriptPage(sessionId: "s", limit: 10, before: try #require(older.nextBefore))
        #expect(last.messages.map(\.id) == (0..<5).map { "m\($0)" })
        #expect(last.complete && last.nextBefore == nil)
        // No page repeats or skips a row.
        let all = (last.messages + older.messages + newest.messages).map(\.id)
        #expect(all == (0..<25).map { "m\($0)" })
    }

    @Test func aScanCapResumesBelowWhatWasRead() {
        // A chat of nothing but tool rows: the scan stops at the cap and says it is not at the start.
        var next: Int64 = 100_000
        let page = ConductorText.readPage(before: nil, limit: 5, scanCap: 5_000) { _, count in
            (0..<count).map { _ in
                next -= 1
                return SessionMessageRecord(id: "r\(next)", role: "assistant", content: toolResultRow, cursor: next)
            }
        }
        #expect(page.messages.isEmpty)
        #expect(!page.complete)
        let expected: Int64 = 100_000 - 6_200
        #expect(page.nextBefore == expected) // 200, then chunks of 2000 until 5000 rows were read
    }

    @Test func cancelledRowsAreSkipped() throws {
        let f = try ConductorFixture()
        try f.addSession("s")
        try f.addMessage("s", role: "user", content: "kept", sentAt: "2026-10-18T09:00:00.000Z", id: "a")
        try f.addMessage("s", role: "user", content: "gone", sentAt: "2026-10-18T09:00:01.000Z", id: "b")
        try f.exec("UPDATE session_messages SET cancelled_at = '2026-10-18T09:00:02.000Z' WHERE id = 'b'")
        let page = try ConductorRegistry(database: f.database).transcriptPage(sessionId: "s", limit: 10, before: nil)
        #expect(page.messages.map(\.id) == ["a"])
    }
}

/// A host that pages: its history is a fixed list, served newest window first and older pages by cursor.
actor PagedAdapter: HostAdapter {
    nonisolated let id = "paged"
    private let session: HostSession
    private var history: [ChatMessage]
    private(set) var failNext = false
    private(set) var pageReads: [String?] = []

    init(session: HostSession, count: Int, start: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
        self.session = session
        history = (0..<count).map { i in
            ChatMessage(id: "m\(i)", role: i % 2 == 0 ? .user : .assistant, text: "message \(i)",
                        at: start.addingTimeInterval(Double(i)), turnId: "t\(i / 2)", cursor: String(i + 1))
        }
    }

    func setFailNext(_ v: Bool) { failNext = v }
    func append(_ m: ChatMessage) { history.append(m) }

    func discover() async throws -> [HostSession] { [session] }

    func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        try await transcriptPage(for: session, limit: limit, before: nil).messages
    }

    func transcriptPage(for session: HostSession, limit: Int, before: String?) async throws -> TranscriptPage {
        pageReads.append(before)
        if failNext { failNext = false; throw AdapterError.timedOut }
        let upper = before.flatMap(Int.init) ?? Int.max
        let eligible = history.filter { Int($0.cursor ?? "0")! < upper }
        let window = Array(eligible.suffix(limit))
        let more = eligible.count > window.count
        return TranscriptPage(messages: window, nextBefore: more ? window.first?.cursor : nil)
    }

    func activity(for session: HostSession) async throws -> [ActivityStep] { [] }
    func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult { .accepted(via: "conductor") }
    nonisolated func openInHostURL(for session: HostSession) -> URL? { nil }
    func health() async -> AdapterHealth { AdapterHealth(adapterId: id, status: .connected) }
}

@Suite("Broker paging")
struct BrokerPagingTests {
    let s = makeSession("c1", state: .finished)

    func make(_ adapter: PagedAdapter, limit: Int = 10) -> Broker {
        Broker(adapters: [adapter], clock: FakeClock(), transcriptLimit: limit)
    }

    @Test func loadingEarlierPrependsAndKeepsTheLiveWindow() async {
        let a = PagedAdapter(session: s, count: 40)
        let broker = make(a)
        await broker.refresh()
        await broker.setFocused(s.key)
        await broker.refreshTranscript()
        #expect(await broker.messages(for: s.key).map(\.id) == (30..<40).map { "m\($0)" })
        #expect(await broker.paging(for: s.key) == EarlierPaging())
        #expect(await broker.loadEarlier(for: s.key, count: 15) == .loaded(15))
        #expect(await broker.messages(for: s.key).map(\.id) == (15..<40).map { "m\($0)" })
        // New messages arrive; the next poll reads only the newest window and must not drop the older page.
        await a.append(ChatMessage(id: "m40", role: .user, text: "new", at: Date(timeIntervalSince1970: 1_800_000_100), cursor: "41"))
        await broker.refreshTranscript()
        #expect(await broker.messages(for: s.key).map(\.id) == (15..<41).map { "m\($0)" })
    }

    @Test func pagingReachesTheStartAndSaysSo() async {
        let a = PagedAdapter(session: s, count: 14)
        let broker = make(a)
        await broker.refresh()
        await broker.setFocused(s.key)
        await broker.refreshTranscript()
        #expect(await broker.loadEarlier(for: s.key, count: 20) == .loaded(4))
        #expect(await broker.paging(for: s.key).reachedStart)
        #expect(await broker.messages(for: s.key).count == 14)
        #expect(await broker.loadEarlier(for: s.key) == .reachedStart)
        // The start stays reached across the next live read.
        await broker.refreshTranscript()
        #expect(await broker.paging(for: s.key).reachedStart)
    }

    @Test func aFailureIsKeptForRetryNotSwallowed() async {
        let a = PagedAdapter(session: s, count: 40)
        let broker = make(a)
        await broker.refresh()
        await broker.setFocused(s.key)
        await broker.refreshTranscript()
        await a.setFailNext(true)
        guard case .failed = await broker.loadEarlier(for: s.key) else { Issue.record("expected a failure"); return }
        let failed = await broker.paging(for: s.key)
        #expect(failed.error != nil && !failed.loading && !failed.reachedStart)
        #expect(await broker.messages(for: s.key).count == 10)
        #expect(await broker.loadEarlier(for: s.key, count: 5) == .loaded(5))
        #expect(await broker.paging(for: s.key).error == nil)
    }

    @Test func aWindowThatDoesNotOverlapReplacesRatherThanJoiningAcrossAGap() {
        let old = (0..<5).map { ChatMessage(id: "m\($0)", role: .user, text: "x", cursor: String($0 + 1)) }
        let fresh = (50..<55).map { ChatMessage(id: "m\($0)", role: .user, text: "y", cursor: String($0 + 1)) }
        let r = Broker.merge(window: fresh, into: old)
        #expect(r.messages.map(\.id) == fresh.map(\.id) && !r.keptOlder)
        let overlap = Broker.merge(window: Array(old.suffix(2)) + fresh, into: old)
        #expect(overlap.messages.map(\.id) == ["m0", "m1", "m2", "m3", "m4"] + fresh.map(\.id) && overlap.keptOlder)
    }

    @Test func restoredCacheMessagesPageFromTheirOwnCursors() async {
        let cache = EncryptedCache(configuration: .init(directory: tempDirectory()), keyStore: MemoryKeyStore())
        let a = PagedAdapter(session: s, count: 40)
        let first = Broker(adapters: [a], clock: FakeClock(), cache: cache, transcriptLimit: 10)
        await first.refresh()
        await first.setFocused(s.key)
        await first.refreshTranscript()
        await first.loadEarlier(for: s.key, count: 10)
        let second = Broker(adapters: [a], clock: FakeClock(), cache: cache, transcriptLimit: 10)
        await second.restoreFromCache()
        #expect(await second.messages(for: s.key).count == 20)
        await second.refresh()
        await second.setFocused(s.key)
        await second.refreshTranscript()
        #expect(await second.messages(for: s.key).count == 20) // the cached older page survived the first live read
        #expect(await second.loadEarlier(for: s.key, count: 10) == .loaded(10))
    }
}
