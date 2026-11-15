import Foundation
import SqueakCore
import XCTest
@testable import SqueakUI

final class StatusRollupMetaTests: XCTestCase {
    func testMacWordWinsAndOlderMacFoldsChats() {
        var pond = PhoneSnapshot.Pond(id: "p", name: "greenroom", shared: false)
        let none = PondItem(id: "p", name: "greenroom", pond: pond, sessions: [], meta: pond.meta)
        XCTAssertEqual(none.rollup.activity, .idle)
        pond.activity = "working"; pond.working = 2; pond.needsYou = 0
        let sent = PondItem(id: "p", name: "greenroom", pond: pond, sessions: [], meta: pond.meta)
        XCTAssertEqual(sent.rollup, StatusRollup(activity: .working, working: 2, needsYou: 0))
        XCTAssertEqual(sent.working, 2)
    }

    func testStreamMetaCarriesItsRollup() {
        var stream = PhoneSnapshot.Pond.Stream(id: "s", name: "hk", branch: "hk")
        stream.activity = "needs_you"; stream.needsYou = 1
        var pond = PhoneSnapshot.Pond(id: "p", name: "greenroom", shared: false, streams: [stream])
        pond.projectId = "x"
        XCTAssertEqual(pond.meta.streams?.first?.rollup, StatusRollup(activity: .needsYou, working: 0, needsYou: 1))
        let item = PondItem(id: "p", name: "greenroom", pond: pond, sessions: [], meta: pond.meta)
        XCTAssertEqual(PondList.streams(item).live.first?.rollup.activity, .needsYou)
    }
}
