import XCTest
@testable import SqueakMacCore

final class WorkbenchFocusTests: XCTestCase {
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "squeak", hostSessionId: id) }
    /// The chat "a" sits in pond "greenroom", stream "hong-kong"; no other chat is listed.
    private func place(_ k: SessionKey) -> ChatPlace? { k == key("a") ? ChatPlace(pond: "greenroom", workspace: "hong-kong") : nil }
    private func focus(_ l: WorkbenchLocation) -> WorkbenchFocus { WorkbenchFocus.resolve(l, place: place) }

    func testHome() { XCTAssertEqual(focus(.home), WorkbenchFocus(page: .home)) }

    func testChatInsideAPondFocusesPondAndWorkspace() {
        let f = focus(.chat(key("a")))
        XCTAssertEqual(f, WorkbenchFocus(page: .chat, pond: "greenroom", workspace: "hong-kong", chat: key("a")))
        // The owner's report: a pond is lit with its home open, and just the same with a chat inside it.
        XCTAssertEqual(f.pond, focus(.pondHome(pond: "greenroom")).pond)
    }

    func testChatNotListedHasNoPlace() {
        let f = focus(.chat(key("zzz")))
        XCTAssertEqual(f.page, .chat)
        XCTAssertEqual(f.chat, key("zzz"))
        XCTAssertNil(f.pond)
        XCTAssertNil(f.workspace)
    }

    func testPondPages() {
        XCTAssertEqual(focus(.pondHome(pond: "p")), WorkbenchFocus(page: .pond, pond: "p"))
        XCTAssertEqual(focus(.pondThread(pond: "p", pondId: "x", threadId: "t")), WorkbenchFocus(page: .pond, pond: "p"))
        XCTAssertEqual(focus(.pondSettings(pond: "p")), WorkbenchFocus(page: .pond, pond: "p"))
        XCTAssertTrue(focus(.pondHome(pond: "p")).isPondPage)
    }

    func testArchivedHasNoPond() {
        XCTAssertEqual(focus(.archived), WorkbenchFocus(page: .archived))
        XCTAssertTrue(focus(.archived).isPondPage)
    }

    func testComposeKeepsItsTarget() {
        XCTAssertEqual(focus(.compose(.newThread, pond: "p", workspace: "w")), WorkbenchFocus(page: .compose(.newThread), pond: "p", workspace: "w"))
        XCTAssertEqual(focus(.compose(.newPond, pond: nil, workspace: nil)), WorkbenchFocus(page: .compose(.newPond)))
        XCTAssertEqual(focus(.compose(.newBranch, pond: "p", workspace: nil)).composePage, .newBranch)
    }

    func testSettingsAndUsageClaimNothing() {
        XCTAssertEqual(focus(.settings(.about)), WorkbenchFocus(page: .settings(.about)))
        XCTAssertTrue(focus(.settings(.about)).isSettings)
        XCTAssertEqual(focus(.usage), WorkbenchFocus(page: .usage))
        XCTAssertFalse(focus(.usage).isSettings)
    }

    func testEveryLocationResolvesToExactlyOnePage() {
        let all: [WorkbenchLocation] = [.home, .pondHome(pond: "p"), .pondThread(pond: "p", pondId: "x", threadId: "t"), .pondSettings(pond: "p"), .archived,
                                        .chat(key("a")), .compose(.quickMessage, pond: nil, workspace: nil), .settings(.general), .usage]
        let pages = all.map { focus($0).page }
        XCTAssertEqual(pages.count, 9)
        XCTAssertEqual(Set(pages.map { "\($0)" }).count, 7, "pond pages share one page, the rest differ")
    }
}
