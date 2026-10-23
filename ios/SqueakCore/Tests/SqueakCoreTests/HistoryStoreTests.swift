import XCTest
@testable import SqueakCore

final class HistoryStoreTests: XCTestCase {
    var dir: URL!
    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("history-\(UUID().uuidString)")
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func entries(_ n: Int) -> [LiveTurn.HistoryEntry] {
        (0..<n).map { .init(role: $0 % 2 == 0 ? "user" : "assistant", text: "m\($0)", at: nil, workBefore: $0) }
    }

    func testRoundTripAcrossInstances() {
        let a = HistoryStore(directory: dir, delay: 0)
        a.record(entries(4), for: "chat-1")
        a.flush()
        XCTAssertEqual(HistoryStore(directory: dir).all(), ["chat-1": entries(4)])
    }

    func testEmptyHistoryNeverReplacesAGoodOne() {
        let a = HistoryStore(directory: dir, delay: 0)
        a.record(entries(3), for: "k")
        a.record([], for: "k")
        a.flush()
        XCTAssertEqual(HistoryStore(directory: dir).all()["k"], entries(3))
    }

    func testKeepsOnlyTheNewestChats() {
        let a = HistoryStore(directory: dir, delay: 0)
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        for i in 0..<(HistoryStore.maxChats + 5) { a.record(entries(2), for: "c\(i)", now: t.addingTimeInterval(Double(i))) }
        a.record(entries(3), for: "c0", now: t.addingTimeInterval(100)) // touched again: survives
        a.flush()
        let kept = HistoryStore(directory: dir).all()
        XCTAssertEqual(kept.count, HistoryStore.maxChats)
        XCTAssertNotNil(kept["c0"])
        XCTAssertNil(kept["c1"])
        XCTAssertNotNil(kept["c\(HistoryStore.maxChats + 4)"])
    }

    func testClearRemovesMemoryAndDisk() {
        let a = HistoryStore(directory: dir, delay: 0)
        a.record(entries(2), for: "k")
        a.flush()
        a.clear()
        a.flush() // waits for the removal queued by clear
        XCTAssertTrue(a.all().isEmpty)
        XCTAssertTrue(HistoryStore(directory: dir).all().isEmpty)
    }
}
