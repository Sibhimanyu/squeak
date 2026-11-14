import CryptoKit
import XCTest
@testable import SqueakCore

final class ChatHistoryStoreTests: XCTestCase {
    var dir: URL!
    let key = SymmetricKey(size: .bits256)
    override func setUp() { dir = FileManager.default.temporaryDirectory.appendingPathComponent("chs-\(UUID().uuidString)") }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func entries(_ range: ClosedRange<Int>, prefix: String = "m") -> [LiveTurn.HistoryEntry] {
        range.map { .init(role: $0 % 2 == 0 ? "user" : "assistant", text: "\(prefix)\($0)", at: nil, id: "\($0)") }
    }
    func store(_ mac: String = "mac-1", chats: Int = 200, bytes: Int = 50_000_000, key: SymmetricKey? = nil) -> ChatHistoryStore {
        ChatHistoryStore(directory: dir, macId: mac, key: key ?? self.key, maxChats: chats, maxBytes: bytes, delay: 0)
    }
    func files(_ mac: String = "mac-1") -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: ChatHistoryStore.folder(dir, macId: mac), includingPropertiesForKeys: nil)) ?? []
    }
    /// Gives each file a distinct last-opened time, oldest first in the order written.
    func age(_ urls: [URL], newestFirst order: [Int]) {
        for (rank, i) in order.enumerated() {
            try? FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: Double(-100 * (rank + 1)))], ofItemAtPath: urls[i].path)
        }
    }

    func testRoundTripAcrossInstancesKeepsMessagesAndCursor() async {
        let a = store()
        a.record(ChatHistoryState(entries: entries(1...4), nextBefore: "1", complete: false), for: "chat-1")
        a.flush()
        let back = await store().load("chat-1")
        XCTAssertEqual(back?.entries, entries(1...4))
        XCTAssertEqual(back?.newestCursor, "4")
        XCTAssertEqual(back?.nextBefore, "1")
        let missing = await store().load("chat-2")
        XCTAssertNil(missing)
    }

    func testEmptyHistoryIsIgnoredAndTheNewestWriteWins() async {
        let a = store()
        a.record(ChatHistoryState(entries: entries(1...3)), for: "k")
        a.record(ChatHistoryState(), for: "k")
        a.record(ChatHistoryState(entries: entries(1...5)), for: "k")
        a.flush()
        let back = await store().load("k")
        XCTAssertEqual(back?.entries.count, 5)
    }

    func testBytesOnDiskContainNoPlaintextAndTheWrongKeyReadsNothing() async throws {
        let a = store()
        a.record(ChatHistoryState(entries: entries(1...3, prefix: "SECRET-WORDS-")), for: "claude-transcript:very-private")
        a.flush()
        let list = files()
        XCTAssertEqual(list.count, 1)
        let data = try Data(contentsOf: list[0])
        XCTAssertNil(data.range(of: Data("SECRET-WORDS".utf8)))
        XCTAssertNil(data.range(of: Data("very-private".utf8)))
        XCTAssertFalse(list[0].lastPathComponent.contains("private"))
        XCTAssertFalse(ChatHistoryStore.folder(dir, macId: "mac-1").lastPathComponent.contains("mac-1"))
        let other = await store(key: SymmetricKey(size: .bits256)).load("claude-transcript:very-private")
        XCTAssertNil(other)
    }

    func testEvictsLeastRecentlyOpenedByChatCount() async {
        let a = store(chats: 3)
        for i in 0..<3 { a.record(ChatHistoryState(entries: entries(1...2)), for: "c\(i)"); a.flush() }
        // Make every file old, oldest-opened distinct, then open c0 so it is the newest.
        let urls = files()
        age(urls, newestFirst: [0, 1, 2])
        _ = await a.load("c0")
        a.record(ChatHistoryState(entries: entries(1...2)), for: "c3")
        a.flush()
        XCTAssertEqual(files().count, 3)
        let b = store(chats: 3)
        let c0 = await b.load("c0"), c3 = await b.load("c3")
        XCTAssertNotNil(c0)
        XCTAssertNotNil(c3)
    }

    func testEvictsByBytesDroppingTheOldest() async {
        let big = (1...40).map { LiveTurn.HistoryEntry(role: "user", text: String(repeating: "x", count: 2000), at: nil, id: "\($0)") }
        let a = store(bytes: 200_000)
        for i in 0..<2 { a.record(ChatHistoryState(entries: big), for: "c\(i)"); a.flush() }
        age(files(), newestFirst: [0, 1])
        a.record(ChatHistoryState(entries: big), for: "c2")
        a.flush()
        let total = files().reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        XCTAssertLessThanOrEqual(total, 200_000)
        XCTAssertLessThan(files().count, 3)
        let kept = await store(bytes: 200_000).load("c2")
        XCTAssertNotNil(kept)
    }

    func testWipeRemovesOnlyThatMacsStoreAndWipeAllEverything() async {
        let a = store("mac-1"), b = store("mac-2")
        a.record(ChatHistoryState(entries: entries(1...2)), for: "k"); a.flush()
        b.record(ChatHistoryState(entries: entries(1...2)), for: "k"); b.flush()
        a.wipe()
        let gone = await store("mac-1").load("k"), kept = await store("mac-2").load("k")
        XCTAssertNil(gone)
        XCTAssertNotNil(kept)
        ChatHistoryStore.wipeAll(directory: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path))
    }

    func testTrimsToTheNewestEntriesAndMovesTheCursor() async {
        let a = store()
        a.record(ChatHistoryState(entries: entries(1...(ChatHistoryStore.maxEntries + 50)), nextBefore: "1"), for: "k"); a.flush()
        let back = await store().load("k")
        XCTAssertEqual(back?.entries.count, ChatHistoryStore.maxEntries)
        XCTAssertEqual(back?.nextBefore, "51")
    }
}

final class HistoryDeltaMergeTests: XCTestCase {
    func e(_ range: ClosedRange<Int>) -> [LiveTurn.HistoryEntry] { range.map { .init(role: "user", text: "m\($0)", at: nil, id: "\($0)") } }
    func delta(_ entries: [LiveTurn.HistoryEntry], next: String? = nil, reset: Bool = false) -> HistoryDelta {
        HistoryDelta(key: "k", after: "x", entries: entries, nextAfter: next, reset: reset)
    }

    func testAppendsAfterTheNewestAndDedupesWhatTheLivePushBrought() {
        var state = ChatHistoryState(entries: e(1...5))
        state.mergeLatest(e(5...8)) // the live push landed first
        XCTAssertFalse(state.applyDelta(delta(e(6...10))))
        XCTAssertEqual(state.entries.map(\.id), (1...10).map { "\($0)" })
        XCTAssertEqual(state.newestCursor, "10")
    }

    func testReportsMoreWhenTheMacHasAnotherPage() {
        var state = ChatHistoryState(entries: e(1...5))
        XCTAssertTrue(state.applyDelta(delta(e(6...55), next: "55")))
        XCTAssertEqual(state.newestCursor, "55")
    }

    func testEmptyDeltaChangesNothing() {
        var state = ChatHistoryState(entries: e(1...5))
        XCTAssertFalse(state.applyDelta(delta([])))
        XCTAssertEqual(state.entries, e(1...5))
    }

    func testResetMergesLikeALivePushAndKeepsWhatWasHeld() {
        var state = ChatHistoryState(entries: e(1...5))
        XCTAssertFalse(state.applyDelta(delta(e(100...105), reset: true)))
        XCTAssertEqual(state.entries.last?.id, "105")
    }

    func testRequestAndCapabilityShapes() throws {
        XCTAssertTrue(ChannelCrypto.capabilities.contains("histdelta"))
        let withAfter = HistoryCommand(v: 1, kind: "history", key: "k", before: nil, after: "12", n: 50, nonce: "n", expiresAt: 1)
        XCTAssertTrue(String(data: try JSONEncoder().encode(withAfter), encoding: .utf8)!.contains("\"after\":\"12\""))
        let plain = HistoryCommand(v: 1, kind: "history", key: "k", before: "9", n: 12, nonce: "n", expiresAt: 1)
        XCTAssertFalse(String(data: try JSONEncoder().encode(plain), encoding: .utf8)!.contains("after"))
        XCTAssertEqual(LiveTurn.historyDeltaDoc(for: "k", after: "7"), LiveTurn.handle(for: "k") + "-ha7")
    }
}
