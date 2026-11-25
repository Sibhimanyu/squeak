import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondForYouTests {
    func chat(_ id: String, name: String? = "Pip", title: String = "Greeting Exchange Start", unread: Bool = false, waiting: Bool = false) -> ForYouChat {
        ForYouChat(sessionId: id, duckName: name, title: title, unread: unread, waiting: waiting)
    }

    @Test func nothingForYouIsAnEmptyCardAndNoBadge() {
        let f = PondForYou.build([chat("a"), chat("b")])
        #expect(f.isEmpty)
        #expect(f.marks().badge == nil)
    }

    @Test func theBadgeIsAlwaysTheCardsCount() {
        let sets: [[ForYouChat]] = [
            [chat("a", unread: true)],
            [chat("a", unread: true), chat("b", waiting: true), chat("c")],
            [chat("a", unread: true, waiting: true), chat("b", unread: true)],
        ]
        for chats in sets {
            let f = PondForYou.build(chats)
            #expect(f.marks().badge == (f.count == 0 ? nil : f.count))
        }
    }

    @Test func aChatThatIsBothAppearsOnceAsWaiting() {
        let f = PondForYou.build([chat("a", unread: true, waiting: true)])
        #expect(f.items.map(\.reason) == [.waiting])
    }

    @Test func waitingComesFirstAndNamesAreTheDucks() {
        let f = PondForYou.build([chat("a", name: "Ruby", unread: true), chat("b", name: "Quill 2", waiting: true)])
        #expect(f.items.map(\.name) == ["Quill 2", "Ruby"])
        #expect(f.items[1].line == "Ruby \u{00B7} finished, not opened yet")
    }

    @Test func aChatTitleIsNeverTheName() {
        let f = PondForYou.build([chat("a", name: nil, title: "Greeting Exchange Start", unread: true)])
        #expect(f.items[0].name == "A Duck")
    }

    @Test func theHostsNeedsStillShowTheTriangle() {
        #expect(PondForYou.build([]).marks(hostNeeds: 2).needsYou)
        #expect(!PondForYou.build([chat("a", unread: true)]).marks().needsYou)
    }
}
