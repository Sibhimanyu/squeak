import XCTest
@testable import SqueakMacCore

final class PondChromeTests: XCTestCase {
    func testMembershipDefaultsFromJoined() {
        XCTAssertEqual(PondMembership.resolve(nil, isJoined: false), .owner)
        XCTAssertEqual(PondMembership.resolve(nil, isJoined: true), .remote)
        XCTAssertEqual(PondMembership.resolve("git", isJoined: true), .git)
        XCTAssertEqual(PondMembership.resolve("nonsense", isJoined: true), .remote)
    }

    func testDirectoryDecodesAccess() throws {
        let json = #"{"ponds":[{"id":"a","name":"A","access":"git"},{"id":"b","name":"B","kind":"joined"},{"id":"c","name":"C","kind":"joined","access":"remote"},{"id":"d","name":"D"}]}"#
        let d = try JSONDecoder().decode(PondDirectory.self, from: Data(json.utf8))
        XCTAssertEqual(d.ponds.map(\.membership), [.git, .remote, .remote, .owner])
        XCTAssertNil(d.ponds[1].access)
    }

    func testFocusCarriesAccess() {
        let f = WorkbenchFocus.resolve(.pondHome(pond: "p"), place: { _ in nil }, access: { $0 == "p" ? .remote : .owner })
        XCTAssertEqual(f.access, .remote)
        XCTAssertEqual(WorkbenchFocus.resolve(.home, place: { _ in nil }, access: { _ in .remote }).access, .owner)
    }

    func testRemoteHidesCode() {
        let c = PondChrome(access: .remote, ownerName: "Asha")
        XCTAssertFalse(c.showsCode); XCTAssertFalse(c.showsBranchAndPR); XCTAssertFalse(c.showsAgentModelPickers)
        XCTAssertTrue(c.inspectorPeopleRecentOnly); XCTAssertTrue(c.showsLeave)
        XCTAssertEqual(c.badge, "Remote")
        XCTAssertEqual(c.composer, .runsOnOwner(line: "Runs on Asha\u{2019}s Mac"))
        XCTAssertEqual(c.start, .askOwner(label: "Ask Asha\u{2019}s Mac to start"))
    }

    func testRemoteWithoutStartCapHidesStart() {
        XCTAssertEqual(PondChrome(access: .remote, ownerName: nil, canStart: false).start, .hidden)
        XCTAssertEqual(PondChrome(access: .remote).start, .askOwner(label: "Ask the owner\u{2019}s Mac to start"))
    }

    func testDisabledComposerCarriesReason() {
        let c = PondChrome(access: .remote, canMessage: false, reason: "The owner has turned off messaging for you in this pond.")
        XCTAssertEqual(c.composer, .disabled(reason: "The owner has turned off messaging for you in this pond."))
    }

    func testOwnerAndGitKeepEverythingAndOwnerNeverLeaves() {
        for a in [PondMembership.owner, .git] {
            let c = PondChrome(access: a)
            XCTAssertTrue(c.showsCode && c.showsBranchAndPR && c.showsAgentModelPickers)
            XCTAssertEqual(c.composer, .full); XCTAssertEqual(c.start, .own); XCTAssertNil(c.badge)
        }
        XCTAssertFalse(PondChrome(access: .owner).showsLeave)
        XCTAssertTrue(PondChrome(access: .git).showsLeave)
    }

    func testPeopleOnlyStripAndPlus() {
        let rec = InspectorTabsRecord(open: [.code, .files], selected: .code)
        let s = InspectorStrip.make(context: .pond, record: rec, terminals: [UUID()], peopleOnly: true)
        XCTAssertEqual(s.tabs, [.pond]); XCTAssertEqual(s.selected, .pond)
        XCTAssertTrue(InspectorStrip.plusItems(context: .pond, peopleOnly: true).isEmpty)
        XCTAssertEqual(InspectorStrip.make(context: .pond, record: rec).tabs, [.pond, .artifacts, .code, .files])
        // Beside a chat, a remote pond keeps its panels with no Artifacts; an owner's has the pinned tab.
        XCTAssertEqual(InspectorStrip.make(context: .stream(panels: [.code]), peopleOnly: true).tabs, [.panel(.code)])
        XCTAssertEqual(InspectorStrip.make(context: .stream(panels: [.code])).tabs, [.panel(.code), .artifacts])
    }

    func testTabCapMemoSurvivesInfiniteWidth() {
        XCTAssertEqual(TabCapMemo.Key(titles: ["a"], width: .infinity).widthBucket, -1)
    }
}
