import Foundation
import XCTest
@testable import SqueakCore

/// "History cache" Layer 2 on the phone: what the Mac seals into the cloud (src/remote/history-cloud.ts, the fixture is its
/// own output) opens here, and lands in the history store without a repeated or lost message.
final class HistoryCloudTests: XCTestCase {
    struct Fixture: Decodable {
        let key: String
        let chatKey: String
        let indexBox: String
        let pages: [String: String]
    }

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "history-cloud", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func entry(_ n: Int) -> LiveTurn.HistoryEntry {
        .init(role: n % 2 == 0 ? "user" : "assistant", text: "message \(n)", at: nil, id: String(1000 + n * 3))
    }

    private func page(_ range: Range<Int>, key: String = "k") -> HistoryCloudPage {
        HistoryCloudPage(key: key, first: String(1000 + range.lowerBound * 3), entries: range.map(entry))
    }

    private func chat(pages: [Range<Int>], newest: Int, complete: Bool = false) -> HistoryCloudIndex.Chat {
        .init(key: "k", pages: pages.map { .init(f: String(1000 + $0.lowerBound * 3)) }, newest: String(1000 + newest * 3), complete: complete)
    }

    func testOpensWhatTheMacSealed() throws {
        let f = try fixture()
        let index = try ChannelCrypto.open(HistoryCloudIndex.self, box: f.indexBox, key: f.key)
        XCTAssertEqual(index.v, 1)
        let chat = try XCTUnwrap(index.chat(f.chatKey))
        XCTAssertEqual(chat.pages.map(\.f), ["1000", "1150", "1300"])
        XCTAssertEqual(chat.newest, "1357")
        XCTAssertTrue(chat.complete)
        var all: [LiveTurn.HistoryEntry] = []
        for ref in chat.pages {
            let box = try XCTUnwrap(f.pages[ref.f])
            let page = try ChannelCrypto.open(HistoryCloudPage.self, box: box, key: f.key)
            XCTAssertEqual(page.key, f.chatKey)
            XCTAssertEqual(page.first, ref.f)
            XCTAssertEqual(page.first, page.entries.first?.id)
            XCTAssertEqual(HistoryCloud.pageDoc(for: f.chatKey, first: ref.f), LiveTurn.handle(for: f.chatKey) + "-" + ref.f)
            all += page.entries
        }
        XCTAssertEqual(all.count, 120)
        XCTAssertEqual(all.first?.text, "message 0")
        XCTAssertEqual(all.last?.text, "message 119")
        XCTAssertEqual(Set(all.compactMap(\.id)).count, 120)
    }

    func testANewDeviceReadsEveryPageAndKnowsTheChatStartsThere() throws {
        let c = chat(pages: [0..<50, 50..<100, 100..<120], newest: 119, complete: true)
        XCTAssertEqual(HistoryCloud.pagesToRead(held: nil, chat: c).count, 3)
        var state = ChatHistoryState()
        let changed = state.mergeCloud([page(0..<50), page(50..<100), page(100..<120)], chat: c)
        XCTAssertTrue(changed)
        XCTAssertEqual(state.entries.count, 120)
        XCTAssertTrue(state.complete)
        XCTAssertNil(state.cursor)
        // the Mac's delta then carries on from the newest entry
        XCTAssertEqual(state.newestCursor, "1357")
    }

    func testAChatTrimmedByTheCloudIsNotMarkedComplete() {
        let c = chat(pages: [50..<100, 100..<120], newest: 119, complete: false)
        var state = ChatHistoryState()
        state.mergeCloud([page(50..<100), page(100..<120)], chat: c)
        XCTAssertFalse(state.complete)
        XCTAssertEqual(state.cursor, state.entries.first?.id) // "Earlier" asks the Mac, from the oldest entry held
    }

    func testAHeldChatReadsOnlyFromThePageThatHoldsItsNewestEntry() {
        let c = chat(pages: [0..<50, 50..<100, 100..<120], newest: 119)
        var held = ChatHistoryState(entries: (0..<60).map(entry))
        XCTAssertEqual(HistoryCloud.pagesToRead(held: held, chat: c).map(\.f), ["1150", "1300"])
        // held is current: nothing to read
        held = ChatHistoryState(entries: (0..<120).map(entry))
        XCTAssertTrue(HistoryCloud.pagesToRead(held: held, chat: c).isEmpty)
        // held is newer than the cloud (the phone read the Mac live since): nothing to read, and a merge changes nothing
        held = ChatHistoryState(entries: (0..<125).map(entry))
        XCTAssertTrue(HistoryCloud.pagesToRead(held: held, chat: c).isEmpty)
        XCTAssertFalse(held.mergeCloud([page(100..<120)], chat: c))
        XCTAssertEqual(held.entries.count, 125)
    }

    func testTheCatchUpMergeHasNoDuplicatesAndKeepsWhatWasHeld() {
        let c = chat(pages: [0..<50, 50..<100, 100..<120], newest: 119)
        var state = ChatHistoryState(entries: (0..<60).map(entry))
        XCTAssertTrue(state.mergeCloud([page(50..<100), page(100..<120)], chat: c))
        XCTAssertEqual(state.entries.map(\.id), (0..<120).map { String(1000 + $0 * 3) })
        XCTAssertNil(state.gap)
        // merging again changes nothing
        XCTAssertFalse(state.mergeCloud([page(50..<100), page(100..<120)], chat: c))
        XCTAssertEqual(state.entries.count, 120)
        // the Mac wakes: its delta after the newest entry adds only what came after, once
        let delta = HistoryDelta(key: "k", after: "1357", entries: (120..<123).map(entry), nextAfter: nil, reset: false)
        XCTAssertFalse(state.applyDelta(delta))
        XCTAssertFalse(state.applyDelta(delta))
        XCTAssertEqual(state.entries.count, 123)
        XCTAssertEqual(Set(state.entries.compactMap(\.id)).count, 123)
    }

    func testACloudCopyThatDoesNotReachBackToWhatWasHeldLeavesAGapForTheMac() {
        // held 0..<10 (old); the cloud keeps only 100..<120: the pages do not join, so the Mac fills the hole later
        let c = chat(pages: [100..<120], newest: 119)
        var state = ChatHistoryState(entries: (0..<10).map { i in
            .init(role: "user", text: "old \(i)", at: "2026-11-01T10:00:0\(i)Z", id: String(1000 + i * 3))
        })
        let dated = (100..<120).map { i in
            LiveTurn.HistoryEntry(role: "user", text: "new \(i)", at: "2026-11-14T10:00:00Z", id: String(1000 + i * 3))
        }
        state.mergeCloud([HistoryCloudPage(key: "k", first: "1300", entries: dated)], chat: c)
        XCTAssertEqual(state.entries.count, 30)
        XCTAssertNotNil(state.gap)
        XCTAssertEqual(state.gap?.above, "1300")
    }

    func testCursorsThatDoNotParseAreNeverNewer() {
        XCTAssertFalse(HistoryCloud.isNewer("abc", than: "1"))
        XCTAssertFalse(HistoryCloud.isNewer("5", than: "x"))
        XCTAssertTrue(HistoryCloud.isNewer("10", than: "9"))
    }
}
