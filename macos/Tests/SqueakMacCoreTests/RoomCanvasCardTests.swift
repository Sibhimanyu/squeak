import Foundation
import Testing
@testable import SqueakMacCore

/// Canvas cards on a duck's done line: what the card says and what a tap opens.
@Suite struct RoomCanvasCardTests {
    private let json = """
    {"seq":1,"id":"p1","author":{"kind":"agent","name":"Pip"},"sessionId":"s1","kind":"done","level":"room","text":"Finished the deck",
     "canvases":[{"id":"abc123","path":"/Users/sam/app/canvases/pitch.canvas","slug":"pitch","title":"Pitch","kind":"deck","artboards":3},{"bad":true}],"at":5}
    """

    @Test func decodesCardsAndDropsBadOnes() throws {
        let post = try JSONDecoder().decode(RoomPost.self, from: Data(json.utf8))
        #expect(post.canvases.count == 1)
        #expect(post.canvases[0].title == "Pitch")
    }

    @Test func aPostWithoutCanvasesHasNone() throws {
        let post = try JSONDecoder().decode(RoomPost.self, from: Data(#"{"seq":1,"id":"p","text":"hi","at":1}"#.utf8))
        #expect(post.canvases.isEmpty)
    }

    @Test func subtitleNamesKindAndArtboards() {
        let one = RoomCanvasCard(id: "i", path: "/p", title: "Logo", kind: "logo", artboards: 1)
        #expect(one.subtitle == "Logo \u{00B7} 1 artboard")
        let many = RoomCanvasCard(id: "i", path: "/p", title: "Pitch", kind: "deck", artboards: 3)
        #expect(many.subtitle == "Deck \u{00B7} 3 artboards")
    }

    @Test func ownerOpensTheFolderAndMemberTheViewOnlyBundle() {
        let c = RoomCanvasCard(id: "abc123", path: "/Users/sam/app/canvases/pitch.canvas", title: "Pitch", kind: "deck", artboards: 3)
        #expect(c.openPath(memberView: false) == "/Users/sam/app/canvases/pitch.canvas")
        #expect(c.openPath(memberView: true) == "abc123")
    }

    @Test func onlyADoneLineCarriesItsCards() throws {
        let done = try JSONDecoder().decode(RoomPost.self, from: Data(json.utf8))
        var working = done; working.kind = .working; working.id = "p2"; working.seq = 2
        var feed = RoomFeed()
        feed.apply(page: RoomPage(posts: [done, working], latestSeq: 2, turns: []))
        let lines = RoomMessages.build(feed: feed, owner: "Sam", filesFor: { _ in nil }).compactMap { item -> RoomStatusLine? in
            if case .system(let s) = item { s.status } else { nil }
        }
        #expect(lines.map(\.kind) == [.done, .took])
        #expect(lines[0].canvases.map(\.title) == ["Pitch"])
        #expect(lines[1].canvases.isEmpty)
    }
}
