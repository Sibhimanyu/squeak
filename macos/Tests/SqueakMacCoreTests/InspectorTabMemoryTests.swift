import XCTest
@testable import SqueakMacCore

final class InspectorTabMemoryTests: XCTestCase {
    func testPerWorkspaceWithFallback() {
        var m = InspectorTabMemory()
        m.set("files", for: "a")
        let json = m.json
        XCTAssertEqual(InspectorTabMemory.resolve(json, workspace: "a", fallback: "changes"), "files")
        XCTAssertEqual(InspectorTabMemory.resolve(json, workspace: "b", fallback: "review"), "review")
        XCTAssertEqual(InspectorTabMemory.resolve(json, workspace: nil, fallback: "changes"), "changes")
        XCTAssertEqual(InspectorTabMemory.resolve("garbage", workspace: "a", fallback: "changes"), "changes")
    }

    func testCapDropsOldest() {
        var m = InspectorTabMemory()
        for i in 0..<(InspectorTabMemory.cap + 5) { m.set("files", for: "w\(i)") }
        XCTAssertEqual(m.tabs.count, InspectorTabMemory.cap)
        XCTAssertNil(m.tab(for: "w0"))
        XCTAssertNotNil(m.tab(for: "w\(InspectorTabMemory.cap + 4)"))
    }

    func testDefaultsRoundTrip() {
        let d = UserDefaults(suiteName: "inspector-tab-test-\(UUID().uuidString)")!
        InspectorTabMemory.write("review", workspace: "a", defaults: d)
        XCTAssertEqual(InspectorTabMemory.read(workspace: "a", defaults: d), "review")
        XCTAssertEqual(InspectorTabMemory.read(workspace: "b", defaults: d), "changes")
        InspectorTabMemory.write("files", workspace: nil, defaults: d)
        XCTAssertEqual(InspectorTabMemory.read(workspace: "b", defaults: d), "files")
    }
}
