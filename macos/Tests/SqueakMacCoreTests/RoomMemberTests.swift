import Foundation
import Testing
@testable import SqueakMacCore

// A Member's Room: the real answers of the Member's Mac for someone else's pond (Fixtures/ponds/room-member-*, made by
// scripts/make-room-member-fixtures.ts from an owner's Mac that publishes its Room and a member's Mac behind a real server),
// decoded through RoomClient. When the page, the queued post or the stream changes shape, regenerate and these say what to follow.

private func fixtureText(_ name: String, _ ext: String = "json") throws -> String {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "ponds"))
    return try String(contentsOf: url, encoding: .utf8)
}

private final class Replay: HTTPTransport, @unchecked Sendable {
    var status = 200
    var body = "{}"
    private(set) var requests: [HTTPRequest] = []
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
    func serve(_ name: String, status: Int = 200) throws -> Replay { self.status = status; body = try fixtureText(name); return self }
}

private func member(_ t: Replay, lines: @escaping @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> = { _ in AsyncThrowingStream { $0.finish() } }) -> RoomClient {
    RoomClient(host: NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, lineSource: lines), member: true)
}

@Suite("A Member's Room, real answers")
struct RoomMemberTests {
    @Test func theMemberPageIsTheOwnersPageShape() async throws {
        let t = try Replay().serve("room-member-page")
        let page = try #require(try await member(t).page(project: "pond-1", limit: 50))
        #expect(t.requests.first?.url.path == "/native/ponds/pond-1/room")
        #expect(page.posts.map(\.seq) == [1, 2, 3])
        #expect(page.posts[0].author.kind == .person && page.posts[1].author.kind == .agent)
        #expect(page.posts[1].text == "On it: reading the timer first.")
        #expect(page.latestSeq == 3 && page.threads.isEmpty && page.canPost && page.ownerOffline == nil)
        let task = try #require(page.tasks?.first)
        #expect(task.state == .waiting && task.title == "Please make the timer respect the weather" && task.messageId == page.posts[2].id)
    }

    @Test func theOfflinePageCarriesTheOneSentence() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page-offline")).page(project: "pond-1"))
        #expect(page.ownerOffline?.hasSuffix("Mac is offline; Ducks will pick this up when it's back") == true)
    }

    @Test func aMemberSeesTheRoomReadOnly() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page")).page(project: "pond-1"))
        var feed = RoomFeed()
        feed.apply(page: page)
        let me = page.posts[0].author.id.map { _ in "someone-else" }
        let items = RoomMessages.build(feed: feed, memberView: true, selfId: me)
        var messages: [RoomMessage] = []
        var cards: [RoomTaskCard] = []
        for item in items {
            if case .group(let g) = item { messages += g.messages }
            if case .system(let s) = item, let c = s.task { cards.append(c) }
        }
        #expect(messages.count == 3)
        // Nothing to make a Task from, and nothing to drop: Tasks are made and dropped on the Owner's Mac.
        #expect(messages.allSatisfy { !$0.canMakeTask })
        #expect(cards.count == 1 && cards[0].canDrop == false)
        // The Owner's posts are somebody else's words here, not "mine".
        #expect(messages[0].author != .me)
    }

    @Test func aMemberOwnWordsAreTheirsWhateverMacTheyTypedThemOn() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page-offline")).page(project: "pond-1"))
        var feed = RoomFeed()
        feed.apply(page: page)
        let own = try #require(page.posts.first { $0.author.name == "Aarav" })
        let mine = try #require(own.author.id)
        let items = RoomMessages.build(feed: feed, memberView: true, selfId: mine)
        var messages: [RoomMessage] = []
        for item in items { if case .group(let g) = item { messages += g.messages } }
        #expect(messages.first { $0.postId == own.id }?.author == .me)
        #expect(messages.filter { $0.author == .me }.count == 1)
    }

    @Test func aQueuedMessageSaysWhetherTheOwnersMacIsAway() async throws {
        let ok = Replay()
        _ = try ok.serve("room-member-post", status: 202)
        let sent = try await member(ok).queue(pond: "pond-1", text: "Fine by me.")
        #expect(ok.requests.first?.method == "POST" && ok.requests.first?.url.path == "/native/ponds/pond-1/room")
        #expect(sent.offline == false && sent.line == nil)
        let away = try Replay().serve("room-member-post-offline", status: 202)
        let waiting = try await member(away).queue(pond: "pond-1", text: "Anyone there?")
        #expect(waiting.offline && waiting.line?.hasSuffix("Ducks will pick this up when it's back") == true)
    }

    @Test func theStreamSaysHelloWhoIsAwayAndThenWhatIsNew() async throws {
        let raw = try fixtureText("room-member-stream", "txt")
        let lines = raw.components(separatedBy: "\n")
        let client = member(Replay(), lines: { _ in AsyncThrowingStream { c in for l in lines { c.yield(l) }; c.finish() } })
        var seen: [RoomStreamEvent] = []
        for await e in client.events(project: "pond-1", sleep: { _ in }) {
            seen.append(e)
            if seen.count == 4 { break }
        }
        guard seen.count == 4, case .hello(let latest) = seen[0], case .owner(let away) = seen[1], case .post(let post) = seen[2], case .owner(let back) = seen[3] else {
            Issue.record("unexpected events: \(seen)"); return
        }
        #expect(latest == 4 && post.seq == 5 && post.text == "Anyone there?" && post.author.name == "Aarav")
        #expect(away?.hasSuffix("Ducks will pick this up when it's back") == true)
        #expect(back == nil)
    }

    @Test func aMessageSentWhileTheOwnerIsAwayStaysPendingThenBecomesThePost() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page-offline")).page(project: "pond-1"))
        var feed = RoomFeed()
        feed.apply(page: page)
        let id = feed.addPending(text: "Anyone there?", level: .room, author: RoomAuthor(kind: .person, name: "You"), at: 1)
        #expect(feed.pendingRow(id)?.pending == true)
        // The Owner's Mac returns, applies it in order, and the stream brings the post: the same row, no longer waiting.
        let post = RoomPost(seq: 5, id: "m-x", author: RoomAuthor(kind: .person, name: "Aarav"), text: "Anyone there?", at: 2)
        _ = feed.receive(post)
        #expect(feed.rows.filter { $0.post.text == "Anyone there?" }.count == 1)
        let row = try #require(feed.rows.first { $0.id == id })
        #expect(!row.pending && row.mine && row.post.seq == 5)
    }
}
