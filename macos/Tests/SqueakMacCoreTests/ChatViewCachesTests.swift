import XCTest
@testable import SqueakMacCore

final class ChatViewCachesTests: XCTestCase {
    func testEvictsOldestBeyondCapacity() {
        var lru = KeyedLRU<String, Int>(capacity: 3)
        for k in ["a", "b", "c", "d"] { _ = lru.value(for: k) { 1 } }
        XCTAssertEqual(lru.keys, ["b", "c", "d"])
    }

    func testReadRefreshesAndReuses() {
        var lru = KeyedLRU<String, Int>(capacity: 2)
        _ = lru.value(for: "a") { 1 }
        _ = lru.value(for: "b") { 2 }
        XCTAssertEqual(lru.value(for: "a") { 99 }, 1)
        _ = lru.value(for: "c") { 3 }
        XCTAssertEqual(lru.keys, ["a", "c"])
    }

    func testRemoveAndMinimumCapacity() {
        var lru = KeyedLRU<String, Int>(capacity: 0)
        _ = lru.value(for: "a") { 1 }
        _ = lru.value(for: "b") { 2 }
        XCTAssertEqual(lru.keys, ["b"])
        lru.remove("b")
        XCTAssertEqual(lru.count, 0)
    }

    func testStoreReturnsSameCachesPerKeyAndCaps() {
        let store = ChatViewCacheStore(capacity: 2)
        let k1 = SessionKey(provider: "p", hostSessionId: "1"), k2 = SessionKey(provider: "p", hostSessionId: "2"), k3 = SessionKey(provider: "p", hostSessionId: "3")
        let first = store.caches(for: k1)
        XCTAssertTrue(first === store.caches(for: k1))
        _ = store.caches(for: k2); _ = store.caches(for: k3)
        XCTAssertEqual(store.keys, [k2, k3])
        XCTAssertFalse(first === store.caches(for: k1))
    }
}
