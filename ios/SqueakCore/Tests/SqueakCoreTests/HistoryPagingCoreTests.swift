import XCTest
@testable import SqueakCore

final class HistoryPagingCoreTests: XCTestCase {
    func testAPageDecodesAndAnOldEntryWithoutAnIdStillDecodes() throws {
        let json = #"""
        {"v":1,"key":"k","before":null,"entries":[{"id":"42","role":"user","text":"hi","at":"2026-10-24T10:00:00.000Z","workBefore":3},
        {"role":"assistant","text":"yo"}],"nextBefore":"40","complete":false,"seq":9}
        """#
        let page = try JSONDecoder().decode(HistoryPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.entries[0].id, "42")
        XCTAssertEqual(page.entries[0].workBefore, 3)
        XCTAssertNil(page.entries[1].id)
        XCTAssertNil(page.before)
        XCTAssertEqual(page.nextBefore, "40")
        let old = try JSONDecoder().decode(LiveTurn.HistoryEntry.self, from: Data(#"{"role":"user","text":"x"}"#.utf8))
        XCTAssertNil(old.id)
    }

    func testSessionDecodesWithAndWithoutLastUser() throws {
        let base = #"{"key":"k","label":"l","agent":"claude","state":"finished","lastActivityAt":"2026-10-24T10:00:00.000Z"%@}"#
        let without = try JSONDecoder().decode(PhoneSnapshot.Session.self, from: Data(String(format: base, "").utf8))
        XCTAssertNil(without.lastUser)
        let with = try JSONDecoder().decode(PhoneSnapshot.Session.self,
            from: Data(String(format: base, #","lastUser":{"text":"hello","at":null}"#).utf8))
        XCTAssertEqual(with.lastUser?.text, "hello")
        XCTAssertNil(with.lastUser?.at)
    }

    func testPageDocumentIdMatchesTheMacs() {
        let handle = LiveTurn.handle(for: "claude-transcript:d1")
        XCTAssertEqual(LiveTurn.historyPageDoc(for: "claude-transcript:d1", before: nil), handle + "-hlatest")
        XCTAssertEqual(LiveTurn.historyPageDoc(for: "claude-transcript:d1", before: "4821"), handle + "-h4821")
    }

    func testAWorkAnswerDecodesFromTheResultAndAnOlderResultHasNone() throws {
        let json = #"{"id":"c1","status":"sent","work":{"steps":[{"kind":"tool","text":"Read a.ts"},{"kind":"thinking","text":"hm"}],"more":3}}"#
        let result = try JSONDecoder().decode(CommandResult.self, from: Data(json.utf8))
        XCTAssertEqual(result.work?.steps.map(\.text), ["Read a.ts", "hm"])
        XCTAssertEqual(result.work?.more, 3)
        XCTAssertNil(try JSONDecoder().decode(CommandResult.self, from: Data(#"{"status":"sent"}"#.utf8)).work)
    }
}
