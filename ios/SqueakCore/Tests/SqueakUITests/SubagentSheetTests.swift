import XCTest
@testable import SqueakUI
@testable import SqueakCore

#if canImport(UIKit)
final class SubagentSheetTests: XCTestCase {
    private let task = PhoneSnapshot.Session.BackgroundTask(id: "toolu_01abcdef", kind: "agent", label: "L", status: "running", agentId: "a1b2c3d4e5f607182", hasSteps: true)

    func testEveryEmptyStateSaysWhy() {
        var watch = AppModel.SubagentWatch(key: "k", task: task)
        XCTAssertEqual(SubagentSheet.explanation(for: watch, unavailable: nil), "Asking your Mac\u{2026}")
        XCTAssertNotNil(SubagentSheet.explanation(for: watch, unavailable: "Turn on it"))
        watch.phase = .refused("Open that chat first.")
        XCTAssertEqual(SubagentSheet.explanation(for: watch, unavailable: nil), "Open that chat first.")
        watch.phase = .following
        XCTAssertNotNil(SubagentSheet.explanation(for: watch, unavailable: nil))
        watch.feed = SubagentFeed(key: "k", taskId: task.id, label: "L", status: "running", available: false, total: 0, steps: [])
        XCTAssertTrue(SubagentSheet.explanation(for: watch, unavailable: nil)!.contains("can't be read"))
        watch.feed = SubagentFeed(key: "k", taskId: task.id, label: "L", status: "running", available: true, total: 1, steps: [.init(kind: "note", text: "x")])
        XCTAssertNil(SubagentSheet.explanation(for: watch, unavailable: nil))
    }
}
#endif
