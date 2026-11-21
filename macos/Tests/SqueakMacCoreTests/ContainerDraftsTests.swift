import XCTest

@testable import SqueakMacCore

@MainActor
final class ContainerDraftsTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let d = UserDefaults(suiteName: "ContainerDraftsTests-\(UUID().uuidString)")!
        return d
    }

    func testKeysNeverCollideAcrossContainers() {
        let keys = [
            ContainerDrafts.pond("p", thread: "t"), ContainerDrafts.pond("p", thread: "u"), ContainerDrafts.room("p"),
            ContainerDrafts.native("p"), ContainerDrafts.native("p", item: "q"),
        ]
        XCTAssertEqual(Set(keys).count, keys.count)
    }

    func testDraftSurvivesALaterReadAndARelaunch() {
        let d = defaults()
        let store = ContainerDrafts(defaults: d)
        store.set("half a thought", for: ContainerDrafts.room("r1"))
        XCTAssertEqual(store.draft(for: ContainerDrafts.room("r1")), "half a thought")
        XCTAssertEqual(ContainerDrafts(defaults: d).draft(for: ContainerDrafts.room("r1")), "half a thought")
        XCTAssertEqual(store.draft(for: ContainerDrafts.room("other")), "")
    }

    func testClearOnSendAndEmptyTextRemoveIt() {
        let d = defaults()
        let store = ContainerDrafts(defaults: d)
        store.set("a", for: "k")
        store.clear("k")
        XCTAssertEqual(ContainerDrafts(defaults: d).draft(for: "k"), "")
        store.set("b", for: "k")
        store.set("", for: "k")
        XCTAssertEqual(store.count, 0)
        XCTAssertNil(d.data(forKey: "squeak.composerDrafts"))
    }

    func testFallbackOnlyWhenThereIsNoDraft() {
        let store = ContainerDrafts(defaults: defaults())
        XCTAssertEqual(store.draft(for: "k", fallback: "queued words"), "queued words")
        store.set("my edit", for: "k")
        XCTAssertEqual(store.draft(for: "k", fallback: "queued words"), "my edit")
    }

    func testOnlyTheNewestDraftsAreKept() {
        let store = ContainerDrafts(defaults: defaults(), capacity: 2)
        store.set("1", for: "a")
        Thread.sleep(forTimeInterval: 0.01)
        store.set("2", for: "b")
        Thread.sleep(forTimeInterval: 0.01)
        store.set("3", for: "c")
        XCTAssertEqual(store.count, 2)
        XCTAssertEqual(store.draft(for: "a"), "")
        XCTAssertEqual(store.draft(for: "c"), "3")
    }
}
