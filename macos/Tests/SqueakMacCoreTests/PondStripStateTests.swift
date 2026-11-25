import XCTest
@testable import SqueakMacCore

/// Regressions for the Room that ignored clicks and the switch that disagreed with the visible page.
final class PondStripStateTests: XCTestCase {
    private let chat = SessionKey(provider: "squeak", hostSessionId: "abc")
    private var staleLive: String? { PondCentre.liveDuck(selected: "abc", location: .pondHome(pond: "p"), selectedKey: chat) }

    /// lastChat is kept while the Room covers the chat, so a stale selected Duck made clicking that same Duck a no-op (the
    /// centre already "showed" it) and a swipe a no-op (a Duck "covered" the pages) while the strip still moved.
    func testDuckIsOnlyShowingWhenTheLocationIsThatChat() {
        XCTAssertNil(staleLive)
        XCTAssertEqual(PondCentre.liveDuck(selected: "abc", location: .chat(chat), selectedKey: chat), "abc")
    }

    func testClickingTheSameDuckFromTheRoomOpensIt() {
        let old = PondCentre(page: .room, duck: staleLive)
        var next = old
        next.deepLink(duck: "abc")
        XCTAssertEqual(next.effects(from: old).openDuck, "abc")
    }

    func testSwipeFromTheRoomLandsEvenWhenAChatWasOpenBefore() {
        let old = PondCentre(page: .room, duck: staleLive)
        var next = old
        next.swipe(to: .dashboard)
        XCTAssertEqual(next.page, .dashboard)
        XCTAssertEqual(next.switchSelection, .dashboard)
    }

    /// The visible page must always take clicks, the off-screen one never.
    func testOnlyTheShownPageTakesClicks() {
        XCTAssertTrue(PondStripPlan.takesClicks(page: .dashboard, drawn: 0))
        XCTAssertFalse(PondStripPlan.takesClicks(page: .room, drawn: 0))
        XCTAssertTrue(PondStripPlan.takesClicks(page: .room, drawn: 1))
        XCTAssertFalse(PondStripPlan.takesClicks(page: .dashboard, drawn: 1))
    }

    func testMidSwipeHandsClicksToExactlyOnePage() {
        for p in [0.0, 0.2, 0.3, 0.5, 0.7, 0.8, 1.0] {
            XCTAssertNotEqual(PondStripPlan.takesClicks(page: .dashboard, drawn: p), PondStripPlan.takesClicks(page: .room, drawn: p))
        }
    }
}
