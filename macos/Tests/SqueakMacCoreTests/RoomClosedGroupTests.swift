import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RoomClosedGroupTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func closedGroupIsRecentFirstAndCapped() {
        let ducks = (0..<25).map { PondDuck(id: "d\($0)", name: "Duck \($0)", isOpen: false, lastActiveAt: Int64($0 + 1) * 1000) }
            + [PondDuck(id: "on", name: "On", lastActiveAt: 5)]
        let g = RoomRoster.closedGroup(ducks, now: now)
        #expect(g.rows.count == RoomRoster.closedCap)
        #expect(g.rows.first?.id == "d24")
        #expect(g.more == 5)
        #expect(g.rows.allSatisfy { !$0.isOpen })
    }

    @Test func allClosedStillListsThemWhileAvailableIsEmpty() {
        let ducks = [PondDuck(id: "a", name: "Ada", isOpen: false, lastActiveAt: 10), PondDuck(id: "b", name: "Bo", isOpen: false, lastActiveAt: 20)]
        #expect(RoomRoster.visible(ducks, query: "", now: now).isEmpty)
        #expect(RoomRoster.closedGroup(ducks, now: now).rows.map(\.id) == ["b", "a"])
        #expect(RoomRoster.closedGroup(ducks, now: now).more == 0)
    }

    @Test func subtitleNeverCountsClosedDucks() {
        #expect(RoomDucks.subtitle(people: 2, ducks: 3) == "2 people \u{00B7} 3 ducks open")
        #expect(RoomDucks.subtitle(people: 1, ducks: 0) == "1 person \u{00B7} no ducks open")
    }
}
