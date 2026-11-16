import XCTest
@testable import SqueakMacCore

final class ApprovalPresentationTests: XCTestCase {
    func testClipLongCommand() {
        let text = (1...60).map { "line \($0)" }.joined(separator: "\n")
        let c = ApprovalPresentation.clip(text)
        XCTAssertTrue(c.clipped); XCTAssertEqual(c.total, 60); XCTAssertEqual(c.hiddenLines, 54)
        XCTAssertEqual(c.shown.split(separator: "\n").count, 6)
        XCTAssertEqual(ApprovalPresentation.disclosureTitle(total: 60, expanded: false), "Show all 60 lines")
    }
    func testShortNotClipped() {
        let c = ApprovalPresentation.clip("ls -la\n\n")
        XCTAssertFalse(c.clipped); XCTAssertEqual(c.total, 1); XCTAssertEqual(c.shown, "ls -la")
    }
    func testTitlesAndCompactLine() {
        XCTAssertEqual(ApprovalPresentation.title(agent: "Claude", tool: "Bash"), "Claude wants to run a command")
        XCTAssertEqual(ApprovalPresentation.compactLine(tool: "Bash"), "Approve: run a command · Bash")
        XCTAssertEqual(ApprovalPresentation.compactLine(tool: "WebFetch"), "Approve: fetch a page · WebFetch")
        XCTAssertEqual(ApprovalPresentation.compactLine(tool: "Foo"), "Approve: use Foo")
    }
    func testDiff() {
        XCTAssertEqual(ApprovalPresentation.diff(old: "a", new: "b\nc"), "- a\n+ b\n+ c")
        XCTAssertNil(ApprovalPresentation.diff(old: nil, new: ""))
    }
}
