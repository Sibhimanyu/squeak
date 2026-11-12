import XCTest
@testable import SqueakMacCore

final class HintPlacementTests: XCTestCase {
    let win = CGRect(x: 0, y: 0, width: 1000, height: 700)
    let hint = CGSize(width: 120, height: 24)

    func testBelowByDefaultAtTopEdge() {
        let c = CGRect(x: 480, y: 0, width: 40, height: 28)
        let o = HintPlacement.origin(control: c, hint: hint, window: win)
        XCTAssertEqual(o.y, 34); XCTAssertEqual(o.x, 440)
    }
    func testAboveNearBottom() {
        let c = CGRect(x: 480, y: 660, width: 40, height: 28)
        let o = HintPlacement.origin(control: c, hint: hint, window: win)
        XCTAssertEqual(o.y, 660 - 6 - 24)
    }
    func testClampsLeftAndRight() {
        XCTAssertEqual(HintPlacement.origin(control: CGRect(x: 0, y: 10, width: 20, height: 20), hint: hint, window: win).x, 4)
        XCTAssertEqual(HintPlacement.origin(control: CGRect(x: 980, y: 10, width: 20, height: 20), hint: hint, window: win).x, 1000 - 4 - 120)
    }
    func testNeverOverlapsControl() {
        for y in stride(from: CGFloat(0), through: 672, by: 8) {
            for x in stride(from: CGFloat(0), through: 960, by: 40) {
                let c = CGRect(x: x, y: y, width: 40, height: 28)
                let o = HintPlacement.origin(control: c, hint: hint, window: win)
                XCTAssertFalse(CGRect(origin: o, size: hint).intersects(c), "\(c)")
                XCTAssertGreaterThanOrEqual(o.x, 0); XCTAssertLessThanOrEqual(o.x + hint.width, 1000)
            }
        }
    }
}
