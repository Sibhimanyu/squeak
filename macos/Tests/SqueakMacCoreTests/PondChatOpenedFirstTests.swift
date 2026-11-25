import XCTest
@testable import SqueakMacCore

/// The chat opened first after a launch: the Pond's top bar must list the open and working Ducks and select the open one.
final class PondChatOpenedFirstTests: XCTestCase {
    private let chat = SessionKey(provider: "squeak", hostSessionId: "abc")
    private let other = SessionKey(provider: "squeak", hostSessionId: "zzz")

    func testLiveDuckForEveryLocationThatRendersAChat() {
        func live(_ l: WorkbenchLocation, key: SessionKey? = SessionKey(provider: "squeak", hostSessionId: "abc")) -> String? {
            PondCentre.liveDuck(selected: "d", location: l, selectedKey: key)
        }
        XCTAssertEqual(live(.chat(chat)), "d")
        // A different workspace or installation is another chat: never the open Duck.
        XCTAssertNil(live(.chat(other)))
        XCTAssertNil(live(.chat(SessionKey(provider: "squeak", hostSessionId: "abc#other"))))
        XCTAssertNil(live(.chat(chat), key: nil))
        // Pages that only cover the chat show no Duck.
        let covers: [WorkbenchLocation] = [
            .home, .pondHome(pond: "p"), .pondThread(pond: "p", pondId: "i", threadId: "t"), .pondSettings(pond: "p"),
            .archived, .compose(.newThread, pond: "p", workspace: nil), .usage,
        ]
        for l in covers { XCTAssertNil(live(l), "\(l)") }
    }

    func testOpenChatIsSelectedAndTheCentreShowsIt() {
        var c = PondCentre(page: .dashboard, duck: PondCentre.liveDuck(selected: "d", location: .chat(chat), selectedKey: chat))
        XCTAssertEqual(c.shows, .duck("d"))
        XCTAssertTrue(c.showsDuckSubheader)
        XCTAssertEqual(c.selectedTab, .duck("d"))
        c.switchTo(.room)
        XCTAssertEqual(c.switchSelection, .room)
    }

    private func roster() -> DuckRoster {
        RoomRoster.roster([
            PondDuck(id: "pickle", name: "Pickle", currentSessionId: "abc"),
            PondDuck(id: "dhol", name: "Dhol", currentSessionId: "def"),
        ])
    }

    func testStripListsOpenAndWorkingDucksAfterARestoredLaunch() {
        let strip = PondWorkspaceStrip(roster: roster(), place: .chat(sessionId: "abc", duckId: nil), items: [], current: nil)
        XCTAssertFalse(strip.isEmpty)
        XCTAssertEqual(Set(strip.tabs().map(\.item)), [.duck("pickle"), .duck("dhol")])
        XCTAssertEqual(strip.row.selectedDuck, "pickle")
        let byDuck = PondWorkspaceStrip(roster: roster(), place: .chat(sessionId: nil, duckId: "dhol"), items: [], current: nil)
        XCTAssertEqual(byDuck.row.selectedDuck, "dhol")
        XCTAssertEqual(byDuck.tabs().count, 2)
    }

    /// Before the host's first answer the roster is empty, so the strip is empty: the bar must fetch the roster itself
    /// (PondSharedHeader), or a chat opened first never gets tabs.
    func testAnEmptyRosterGivesAnEmptyStripSoSomethingOutsideTheStripMustFetchIt() {
        let strip = PondWorkspaceStrip(roster: RoomRoster.roster([]), place: .chat(sessionId: "abc", duckId: nil), items: [], current: nil)
        XCTAssertTrue(strip.isEmpty)
    }
}
