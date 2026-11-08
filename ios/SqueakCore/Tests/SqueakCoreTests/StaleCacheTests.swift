import XCTest
@testable import SqueakCore

final class StaleCacheTests: XCTestCase {
    func testStoresAndReadsLastValueAtAnyAge() {
        var cache = StaleCache<String, Int>()
        cache.store(1, for: "a", at: Date(timeIntervalSince1970: 1000))
        XCTAssertEqual(cache.value(for: "a"), 1)
        XCTAssertNil(cache.value(for: "b"))
    }

    func testFreshnessFollowsTheTTL() {
        var cache = StaleCache<String, Int>()
        let t0 = Date(timeIntervalSince1970: 1000)
        cache.store(1, for: "a", at: t0)
        XCTAssertTrue(cache.isFresh("a", ttl: 30, now: t0.addingTimeInterval(29)))
        XCTAssertFalse(cache.isFresh("a", ttl: 30, now: t0.addingTimeInterval(30)))
        XCTAssertFalse(cache.isFresh("missing", ttl: 30, now: t0))
    }

    func testOverwriteRefreshesAndLimitDropsOldest() {
        var cache = StaleCache<Int, Int>(limit: 2)
        let t0 = Date(timeIntervalSince1970: 0)
        cache.store(1, for: 1, at: t0)
        cache.store(2, for: 2, at: t0)
        cache.store(11, for: 1, at: t0.addingTimeInterval(5))
        cache.store(3, for: 3, at: t0.addingTimeInterval(6))
        XCTAssertNil(cache.value(for: 2))
        XCTAssertEqual(cache.value(for: 1), 11)
        XCTAssertEqual(cache.count, 2)
    }

    func testAppListFileRoundTrips() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("applist-\(UUID().uuidString)/apps.json")
        XCTAssertNil(AppListFile.load(from: url))
        let apps = [PhoneSnapshot.MacApp(id: "com.apple.Safari", name: "Safari")]
        AppListFile.save(apps, to: url)
        XCTAssertEqual(AppListFile.load(from: url), apps)
    }

    func testWaitHintAfterEightSeconds() {
        let t0 = Date(timeIntervalSince1970: 0)
        XCTAssertFalse(WaitHint.isLong(since: t0, now: t0.addingTimeInterval(7.9)))
        XCTAssertTrue(WaitHint.isLong(since: t0, now: t0.addingTimeInterval(8)))
    }
}
