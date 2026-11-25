import Testing

@testable import SqueakMacCore

@Suite struct ChatTurnJumpTests {
    private let rows = [ChatTurnJump.Row(id: "k1", turnId: "t1"), ChatTurnJump.Row(id: "k2", turnId: "t2"), ChatTurnJump.Row(id: "press-3", turnId: nil)]

    @Test func theTurnIsFoundByTheHostsIdWhateverKeyItsRowHas() {
        #expect(ChatTurnJump.rowId(turnId: "t2", among: rows) == "k2")
        #expect(ChatTurnJump.rowId(turnId: "press-3", among: rows) == "press-3")
        #expect(ChatTurnJump.rowId(turnId: "t99", among: rows) == nil)
    }

    @Test func onlyATurnTargetAsksForAPlaceAndTheSameTurnTwiceIsANewRequest() throws {
        #expect(ChatTurnJump.request(for: .duck("s1"), chat: "c", previous: nil) == nil)
        let first = try #require(ChatTurnJump.request(for: .turn(duck: "s1", turnId: "t2"), chat: "c", previous: nil))
        let second = try #require(ChatTurnJump.request(for: .turn(duck: "s1", turnId: "t2"), chat: "c", previous: first))
        #expect(first != second && second.token == first.token + 1)
    }
}
