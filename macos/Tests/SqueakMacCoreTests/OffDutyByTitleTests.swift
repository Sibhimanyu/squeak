import Foundation
import Testing

@testable import SqueakMacCore

/// Names are masks: an Off-duty Duck is known by its chat title.
@Suite struct OffDutyByTitleTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func ms(_ ago: TimeInterval) -> Int64 { Int64((now.timeIntervalSince1970 - ago) * 1000) }

    @Test func decodesTitleAndSummaryAndNullName() throws {
        let json = #"{"id":"d1","name":null,"duty":"off","chatTitle":"Zoom Marketplace review fixes","lastSummary":"Fixed the three review comments.","lastActiveAt":1}"#
        let d = try JSONDecoder().decode(PondDuck.self, from: Data(json.utf8))
        #expect(d.chatTitle == "Zoom Marketplace review fixes" && d.lastSummary == "Fixed the three review comments." && d.duty == .off)
        let bare = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"d2","duty":"off"}"#.utf8))
        #expect(bare.chatTitle == nil && bare.lastSummary == nil)
    }

    @Test func offDutyRowLeadsWithTheTitleAndSaysWhenItWentOff() {
        let off = PondDuck(id: "a", name: "Pip", duty: .off, currentSessionId: "s", lastActiveAt: ms(3 * 86_400 + 60), chatTitle: "Zoom Marketplace review fixes", lastSummary: "Fixed the review comments.")
        let row = RoomRoster.row(off, now: now)
        #expect(row.heading == "Zoom Marketplace review fixes")
        #expect(row.presenceLine == "off duty 3d ago" && row.lastSummary == "Fixed the review comments.")
        // No title: never the name.
        #expect(RoomRoster.row(PondDuck(id: "b", name: "Pip", duty: .off), now: now).heading == "Untitled chat")
        // On duty keeps its name.
        #expect(RoomRoster.row(PondDuck(id: "c", name: "Pip", chatTitle: "Whatever"), now: now).heading == "Pip")
    }

    @Test func searchFindsOffDutyDucksByTitleAndSummaryNotByName() {
        let ducks = [
            PondDuck(id: "a", name: "Pip", duty: .off, lastActiveAt: ms(10), chatTitle: "Zoom Marketplace review fixes", lastSummary: "Fixed the dark mode toggle."),
            PondDuck(id: "b", name: "Sage", lastActiveAt: ms(10), chatTitle: "Unrelated"),
        ]
        #expect(RoomRoster.visible(ducks, query: "marketplace", now: now).map(\.id) == ["a"])
        #expect(RoomRoster.visible(ducks, query: "dark mode", now: now).map(\.id) == ["a"])
        #expect(RoomRoster.visible(ducks, query: "pip", now: now).isEmpty)
        #expect(RoomRoster.visible(ducks, query: "sage", now: now).map(\.id) == ["b"])
    }

    @Test func atListShowsOffDutyByTitleAndInsertsAMentionThatWakesIt() {
        let off = RoomThread(sessionId: "s1", title: "Zoom Marketplace review fixes", state: .idle, name: "Pip", duty: .off, lastActiveAt: ms(3 * 86_400 + 60))
        var withSummary = off
        withSummary.lastSummary = "Fixed the review comments."
        let on = RoomThread(sessionId: "s2", title: "Other", state: .idle, name: "Sage")
        let c = RoomMention.candidates(query: "zoom", threads: [withSummary, on], people: [], now: now)
        #expect(c.count == 1)
        #expect(c[0].addressee.label == "Zoom Marketplace review fixes")
        #expect(c[0].subtitle == "off duty 3d ago \u{00B7} Fixed the review comments.")
        #expect(c[0].insertion == "@Zoom Marketplace review fixes ")
        #expect(RoomMention.candidates(query: "pip", threads: [withSummary], people: [], now: now).isEmpty)
    }

    @Test func dashboardOffDutyRowsCarryTheirNote() {
        let d = PondDuck(id: "a", name: "Pip", duty: .off, currentSessionId: "s1", lastActiveAt: ms(7200), lastSummary: "Done.")
        let notes = PondOffDutyNote.notes([d, PondDuck(id: "b", name: "Sage", currentSessionId: "s2")], now: now)
        #expect(notes == ["s1": PondOffDutyNote(line: "off duty 2h ago", summary: "Done.")])
    }
}
