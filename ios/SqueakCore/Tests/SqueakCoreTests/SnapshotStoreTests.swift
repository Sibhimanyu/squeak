import XCTest
@testable import SqueakCore

final class SnapshotStoreTests: XCTestCase {
    private func snapshot(_ mac: String) -> PhoneSnapshot {
        try! JSONDecoder().decode(PhoneSnapshot.self, from: Data(
            #"{"v":1,"mac":"\#(mac)","generatedAt":"2026-10-19T08:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#.utf8))
    }
    private func folder() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("snap-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    func testAKeptViewComesBackInANewStore() {
        let dir = folder()
        let store = SnapshotStore(directory: dir)
        XCTAssertNil(store.load())
        store.record(snapshot("Studio"))
        store.flush()
        XCTAssertEqual(SnapshotStore(directory: dir).load()?.mac, "Studio")
    }

    func testTheNewestViewWins() {
        let dir = folder()
        let store = SnapshotStore(directory: dir)
        store.record(snapshot("A")); store.record(snapshot("B"))
        store.flush()
        XCTAssertEqual(store.load()?.mac, "B")
    }

    func testClearForgetsItAndAnOldOneIsNotShown() {
        let dir = folder()
        let store = SnapshotStore(directory: dir)
        store.record(snapshot("A")); store.flush()
        XCTAssertNil(store.load(now: Date().addingTimeInterval(SnapshotStore.maxAge + 60)))
        store.clear()
        store.flush()
        XCTAssertNil(store.load())
    }
}
