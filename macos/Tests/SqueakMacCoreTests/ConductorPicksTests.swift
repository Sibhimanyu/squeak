import XCTest
@testable import SqueakMacCore

final class ConductorPicksTests: XCTestCase {
    func testKeepsOnlyPicked() {
        XCTAssertTrue(ConductorPicks.keeps(workspaceId: "a", picked: ["a", "b"]))
        XCTAssertFalse(ConductorPicks.keeps(workspaceId: "c", picked: ["a", "b"]))
        XCTAssertFalse(ConductorPicks.keeps(workspaceId: "a", picked: []))
        XCTAssertFalse(ConductorPicks.keeps(workspaceId: "a", picked: nil))
    }

    private func state(_ json: String) throws -> DaemonState {
        try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
    }

    func testDaemonListWinsAndIsCached() throws {
        let r = ConductorPicks.resolve(state: try state(#"{"conductorWorkspaces":["a"]}"#), cached: ["z"])
        XCTAssertEqual(r.picked, ["a"])
        XCTAssertEqual(r.toCache, ["a"])
    }

    func testOlderDaemonShowsNothing() throws {
        let r = ConductorPicks.resolve(state: try state("{}"), cached: ["z"])
        XCTAssertEqual(r.picked, [])
        XCTAssertNil(r.toCache)
    }

    func testDaemonDownUsesCacheElseNothing() {
        XCTAssertEqual(ConductorPicks.resolve(state: nil, cached: ["z"]).picked, ["z"])
        XCTAssertEqual(ConductorPicks.resolve(state: nil, cached: nil).picked, [])
    }

    func testCacheRoundTrips() throws {
        let d = try XCTUnwrap(UserDefaults(suiteName: "picks-test-\(UUID().uuidString)"))
        let c = ConductorPicksCache(defaults: d)
        XCTAssertNil(c.value)
        c.value = ["a", "b"]
        XCTAssertEqual(c.value, ["a", "b"])
    }

    func testWorkspaceListDecodes() throws {
        let json = #"{"linked":true,"workspaces":[{"id":"w1","repo":"squeak","repoId":"r","name":"ushuaia","branch":"main","state":"archived","chats":3,"lastActivityAt":null,"picked":true},{"bad":1}]}"#
        let l = try JSONDecoder().decode(ConductorWorkspaceList.self, from: Data(json.utf8))
        XCTAssertTrue(l.linked)
        XCTAssertEqual(l.workspaces.count, 1)
        XCTAssertTrue(l.workspaces[0].isArchived)
        XCTAssertTrue(l.workspaces[0].picked)
    }
}
