import Foundation
import XCTest
@testable import SqueakCore

/// Conductor add-on, phase 4: the phone renders from generic fields when the Mac sends them and falls back to
/// the old Conductor rules when it does not.
final class GenericSessionsTests: XCTestCase {
    private func view(_ extra: String = "", session: String) throws -> PhoneSnapshot {
        let json = """
        {"v":1,"mac":"Mac","generatedAt":"2026-11-12T00:00:00Z","duck":{"blockedCount":0,"workingCount":0}\(extra),
         "sessions":[\(session)]}
        """
        return try JSONDecoder().decode(PhoneSnapshot.self, from: Data(json.utf8))
    }

    private func session(_ extra: String) -> String {
        """
        {"key":"k","label":"a · b","agent":"claude","state":"finished","lastActivityAt":"2026-11-12T00:00:00Z"\(extra)}
        """
    }

    func testNewViewDecodesHandleActionsAndSource() throws {
        let v = try view(#","addons":["conductor"]"#, session: session(#","conductorSessionId":"c1","sessionId":"h1","actions":["reply","diff"],"source":{"id":"conductor","label":"Conductor"}"#))
        let s = v.sessions[0]
        XCTAssertEqual(v.addons, ["conductor"])
        XCTAssertEqual(s.handle, "h1")
        XCTAssertTrue(s.can(.reply)); XCTAssertTrue(s.can(.diff))
        XCTAssertFalse(s.can(.rename)); XCTAssertFalse(s.can(.close))
        XCTAssertEqual(s.sourceLabel, "Conductor")
        XCTAssertTrue(s.isConductor)
        XCTAssertTrue(v.conductorEnabled)
    }

    func testNativeChatGetsReplyAndDiffOnly() throws {
        let v = try view(#","addons":[]"#, session: session(#","conductorSessionId":null,"sessionId":"squeak:n1","actions":["reply","diff"],"source":{"id":"squeak","label":"Squeak"}"#))
        let s = v.sessions[0]
        XCTAssertEqual(s.handle, "squeak:n1")
        XCTAssertTrue(s.canReply); XCTAssertFalse(s.can(.stop)); XCTAssertFalse(s.isConductor)
        XCTAssertFalse(v.conductorEnabled)
    }

    func testOldViewFallsBackToConductorRules() throws {
        let v = try view(session: session(#","conductorSessionId":"c1""#))
        let s = v.sessions[0]
        XCTAssertNil(v.addons); XCTAssertNil(s.sessionId); XCTAssertNil(s.actions)
        XCTAssertEqual(s.handle, "c1")
        for action in PhoneSnapshot.SessionAction.allCases where action != .archiveChat { XCTAssertTrue(s.can(action)) }
        XCTAssertFalse(s.can(.archiveChat))
        XCTAssertEqual(s.sourceLabel, "Conductor")
        XCTAssertTrue(s.isConductor)
        XCTAssertTrue(v.conductorEnabled)
    }

    func testOldTerminalViewIsNotActionableAndHasNoConductorUI() throws {
        let v = try view(session: session(#","conductorSessionId":null"#))
        let s = v.sessions[0]
        XCTAssertNil(s.handle); XCTAssertFalse(s.can(.reply)); XCTAssertFalse(s.canReply)
        XCTAssertFalse(v.conductorEnabled)
    }

    func testAddonsAbsentHidesNothingButAddonsEmptyHidesConductorScreens() throws {
        let off = try view(#","addons":[]"#, session: session(#","conductorSessionId":"c1""#))
        XCTAssertFalse(off.conductorEnabled)
    }

    func testPhoneAdvertisesGenericSessionsWithinTheCapLimit() {
        XCTAssertTrue(ChannelCrypto.capabilities.contains("generic-sessions"))
        XCTAssertLessThanOrEqual(ChannelCrypto.capabilities.count + 1, 10)
        XCTAssertTrue(ChannelCrypto.capabilities.allSatisfy { $0.count <= 20 })
    }

    func testFinishedModeDecodesBothSpellingsAndSendsByMac() throws {
        let old = try JSONDecoder().decode(NotifySettings.ChannelSettings.self, from: Data(#"{"finished":"conductor"}"#.utf8))
        let new = try JSONDecoder().decode(NotifySettings.ChannelSettings.self, from: Data(#"{"finished":"replyable"}"#.utf8))
        XCTAssertEqual(NotifyFormat.finishedChoice(old.finished), "replyable")
        XCTAssertEqual(NotifyFormat.finishedChoice(new.finished), "replyable")
        XCTAssertEqual(NotifyFormat.finishedWire("replyable", addons: ["conductor"]), "replyable")
        XCTAssertEqual(NotifyFormat.finishedWire("replyable", addons: []), "replyable")
        XCTAssertEqual(NotifyFormat.finishedWire("replyable", addons: nil), "conductor")
        XCTAssertEqual(NotifyFormat.finishedWire("all", addons: nil), "all")
        XCTAssertEqual(NotifyFormat.finishedModes.first?.title, "Chats you can reply to")
    }

    func testFrontTabsGroupsAndConductorKinds() throws {
        let groups = try JSONDecoder().decode(FrontTabs.self, from: Data(#"{"app":{"id":"a","name":"Conductor"},"kind":"groups","title":"Conductor","workspaces":[]}"#.utf8))
        let old = try JSONDecoder().decode(FrontTabs.self, from: Data(#"{"app":{"id":"a","name":"Conductor"},"kind":"conductor","workspaces":[]}"#.utf8))
        let tabs = try JSONDecoder().decode(FrontTabs.self, from: Data(#"{"kind":"tabs","tabs":[]}"#.utf8))
        XCTAssertTrue(groups.isGroups); XCTAssertEqual(groups.title, "Conductor")
        XCTAssertTrue(old.isGroups); XCTAssertNil(old.title)
        XCTAssertFalse(tabs.isGroups)
    }
}
