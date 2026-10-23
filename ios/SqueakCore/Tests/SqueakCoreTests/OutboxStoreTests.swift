import XCTest
@testable import SqueakCore

final class OutboxStoreTests: XCTestCase {
    var dir: URL!
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("outbox-\(UUID().uuidString)")
    }
    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    func entry(_ id: String, state: OutboxStore.Entry.State = .sending, ago: TimeInterval = 10, text: String = "a long message") -> OutboxStore.Entry {
        OutboxStore.Entry(key: "chat", id: id, text: text, at: now.timeIntervalSince1970 - ago, answersTurn: "t1",
                          messageId: "m-\(id)", mode: "queue", queuedBehindTurn: false, state: state,
                          reason: state == .refused ? "Your Mac is asleep." : nil, commandId: "cmd-\(id)")
    }

    func testUnsettledSendsSurviveARelaunchWithTheirText() {
        let a = OutboxStore(directory: dir, now: now)
        a.replace(with: [entry("1"), entry("2", state: .refused), entry("3", state: .unconfirmed)])
        a.flush()
        let b = OutboxStore(directory: dir, now: now)
        XCTAssertEqual(b.all().map(\.id), ["1", "2", "3"])
        XCTAssertEqual(b.all()[1].reason, "Your Mac is asleep.")
        XCTAssertEqual(b.all()[0].text, "a long message")
        XCTAssertEqual(b.all()[0].commandId, "cmd-1")
    }

    func testReplacingWithNothingForgetsSettledSends() {
        let a = OutboxStore(directory: dir, now: now)
        a.replace(with: [entry("1")])
        a.replace(with: [])
        a.flush()
        XCTAssertEqual(OutboxStore(directory: dir, now: now).all(), [])
    }

    func testADayOldSendIsDropped() {
        let a = OutboxStore(directory: dir, now: now)
        a.replace(with: [entry("old", ago: OutboxStore.maxAge + 60), entry("new")])
        a.flush()
        XCTAssertEqual(OutboxStore(directory: dir, now: now).all().map(\.id), ["new"])
    }

    func testClearRemovesTheFileOnUnpair() {
        let a = OutboxStore(directory: dir, now: now)
        a.replace(with: [entry("1")])
        a.flush()
        a.clear()
        a.flush()
        XCTAssertEqual(a.all(), [])
        XCTAssertEqual(OutboxStore(directory: dir, now: now).all(), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("squeak-outbox.json").path))
    }

    func testIsExcludedFromBackup() throws {
        let a = OutboxStore(directory: dir, now: now)
        a.replace(with: [entry("1")])
        a.flush()
        let values = try dir.appendingPathComponent("squeak-outbox.json").resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testOnlyTheNewestFiftyAreKept() {
        let a = OutboxStore(directory: dir, now: now)
        a.replace(with: (0..<(OutboxStore.maxEntries + 5)).map { entry("\($0)") })
        XCTAssertEqual(a.all().count, OutboxStore.maxEntries)
        XCTAssertEqual(a.all().last?.id, "\(OutboxStore.maxEntries + 4)")
    }
}
