import XCTest

@testable import SqueakMacCore

final class ChatHistoryTests: XCTestCase {
    private func chat(_ id: String, _ title: String, at: TimeInterval?) -> (session: HostSession, title: String, place: String) {
        let s = HostSession(
            key: SessionKey(provider: "x-squeak", hostSessionId: id), title: title, agent: "claude", state: .idle,
            lastActivityAt: at.map { Date(timeIntervalSince1970: $0) })
        return (s, title, "ws · br")
    }

    func testNewestFirstTiesByTitle() {
        let rows = ChatHistory.rows(
            chats: [chat("a", "Beta", at: 10), chat("b", "Alpha", at: 10), chat("c", "Old", at: 1), chat("d", "None", at: nil), chat("e", "New", at: 99)],
            query: "")
        XCTAssertEqual(rows.map(\.title), ["New", "Alpha", "Beta", "Old", "None"])
    }

    func testQueryKeepsTitleMatchesAndHostHitsWithSnippet() {
        let hit = ChatSearchHit(sessionId: "b", in: "message", snippet: "add a zebra here", start: 6, length: 5)
        let rows = ChatHistory.rows(
            chats: [chat("a", "Zebra fix", at: 5), chat("b", "Other", at: 9), chat("c", "Nope", at: 7)], query: "zebra", hits: [hit])
        XCTAssertEqual(rows.map(\.title), ["Other", "Zebra fix"])
        XCTAssertEqual(rows[0].snippet, "add a zebra here")
        XCTAssertEqual(rows[0].highlight, 6..<11)
        XCTAssertNil(rows[1].highlight)
    }

    func testKeyboardSelection() {
        let rows = ChatHistory.rows(chats: [chat("a", "A", at: 3), chat("b", "B", at: 2), chat("c", "C", at: 1)], query: "")
        XCTAssertEqual(ChatHistory.move(from: nil, in: rows, by: 1), rows[0].key)
        XCTAssertEqual(ChatHistory.move(from: rows[0].key, in: rows, by: 1), rows[1].key)
        XCTAssertEqual(ChatHistory.move(from: rows[2].key, in: rows, by: 1), rows[2].key)
        XCTAssertEqual(ChatHistory.move(from: rows[0].key, in: rows, by: -1), rows[0].key)
        XCTAssertNil(ChatHistory.move(from: nil, in: [], by: 1))
        XCTAssertEqual(ChatHistory.reselect(rows[2].key, in: [rows[0]]), rows[0].key)
        XCTAssertEqual(ChatHistory.action(selected: rows[1].key, command: true), .open(rows[1].key, stay: true))
        XCTAssertEqual(ChatHistory.action(selected: nil, command: false), .none)
    }
}
