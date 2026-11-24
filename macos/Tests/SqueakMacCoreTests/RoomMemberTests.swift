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
        // A Member may make a Task from a person's message (the one that already is a Task excepted), but never drops one.
        #expect(messages.filter(\.canMakeTask).map(\.postId) == [page.posts[0].id])
        #expect(cards.count == 1 && cards[0].canDrop == false)
        // Messaging switched off: nothing to make a Task from.
        let muted = RoomMessages.build(feed: feed, memberView: true, selfId: me, canMakeMemberTask: false)
        var mutedMessages: [RoomMessage] = []
        for item in muted { if case .group(let g) = item { mutedMessages += g.messages } }
        #expect(mutedMessages.allSatisfy { !$0.canMakeTask })
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

    // MARK: Tasks that need the Owner's approval

    @Test func makeTaskFromAMemberIsQueuedForTheOwnersMac() async throws {
        let t = try Replay().serve("room-member-task-queued", status: 202)
        let queued = try await member(t).queueTask(pond: "pond-1", messageId: "p-1")
        #expect(t.requests.first?.method == "POST" && t.requests.first?.url.path == "/native/ponds/pond-1/room/tasks")
        let sent = String(decoding: t.requests.first?.body ?? Data(), as: UTF8.self)
        #expect(sent.contains("\"messageId\":\"p-1\""))
        #expect(queued.offline == false)
    }

    @Test func aMembersTaskWaitingForTheOwnerSaysSoToBoth() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page-approval")).page(project: "pond-1"))
        var feed = RoomFeed()
        feed.apply(page: page)
        let waiting = try #require(page.tasks?.first { $0.approvalName != nil })
        #expect(waiting.approvalName == "Aarav" && waiting.state == .waiting)
        // The Member sees whose turn it is and has nothing to press.
        let mine = RoomMessages.build(feed: feed, memberView: true, selfId: "someone-else")
        var memberCards: [RoomTaskCard] = []
        var memberButtons = 0
        for item in mine {
            if case .system(let s) = item {
                memberButtons += s.buttons.count
                if let c = s.task, c.taskId == waiting.id { memberCards.append(c) }
            }
        }
        #expect(memberCards.first?.stateLabel == "Waiting for the Owner\u{2019}s approval" && memberCards.first?.canDrop == false)
        #expect(memberButtons == 0)
        // The Owner's Mac reads the same Task from its own host (`approval`) and gets Approve and Drop.
        let json = #"{"id":"t","messageId":"m","state":"waiting","approval":{"by":"x","name":"Aarav"},"title":"Log each run"}"#
        let hosted = try JSONDecoder().decode(RoomTask.self, from: Data(json.utf8))
        #expect(hosted.approvalName == "Aarav")
        var ownerFeed = RoomFeed()
        ownerFeed.upsert(job: hosted)
        let items = RoomMessages.build(feed: ownerFeed)
        let lines = items.compactMap { item -> RoomSystemLine? in if case .system(let s) = item, s.jobId == "t" { return s }; return nil }
        let line = try #require(lines.first)
        #expect(line.text.hasPrefix("Aarav asked for this task") && line.buttons.map(\.title) == ["Approve", "Drop"])
        #expect(line.buttons.first?.action.body == .object(["action": .string("approve")]))
        // Nothing offers Go or a new duck before the Owner decides, and the card says it needs them.
        #expect(lines.count == 1)
        let card = items.compactMap { item -> RoomTaskCard? in if case .system(let s) = item { return s.task }; return nil }.first
        #expect(card?.stateLabel == "Needs your approval")
    }

    @Test func approvingShowsAtOnceAndAQueuedMakeTaskIsRemembered() throws {
        let hosted = RoomTask(id: "t", messageId: "m", text: "Log each run", approvalName: "Aarav")
        var feed = RoomFeed()
        feed.upsert(job: hosted)
        feed.beginJob("t", action: .approve)
        let items = RoomMessages.build(feed: feed)
        let line = try #require(items.compactMap { item -> RoomSystemLine? in if case .system(let s) = item, s.jobId == "t" { return s }; return nil }.first)
        #expect(line.buttons.isEmpty && line.note == "Approving\u{2026}")
        // The host's answer clears the waiting words.
        var approved = hosted
        approved.approvalName = nil
        approved.updatedAt = 5
        feed.upsert(job: approved)
        #expect(feed.jobLocal["t"] == nil)
        feed.queueJob("msg:p")
        #expect(feed.jobLocal["msg:p"]?.queued == true)
    }

    // The whole Room reaches a Member: a spec+plan card with its detail, a done line's canvas card (view only, no folder), and a
    // comment on the card queued through the Owner's Mac.

    @Test func aMemberPageCarriesPlanDetailAndCanvasCards() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page-plan")).page(project: "pond-1"))
        let plan = try #require(page.posts.first { $0.kind == .plan })
        #expect(plan.text == "Plan: weather-aware timer" && plan.detail?.hasPrefix("Spec: skip a run when rain is forecast.") == true)
        let done = try #require(page.posts.first { $0.kind == .done })
        let card = try #require(done.canvases.first)
        #expect(done.canvases.count == 1 && card.id == "c0ffee" && card.title == "Timer sketch" && card.path.isEmpty)
        #expect(card.subtitle == "Deck \u{00B7} 3 artboards" && card.openPath(memberView: true) == "c0ffee")
        let reply = try #require(page.posts.first { $0.replyTo != nil })
        #expect(reply.replyTo == plan.id && reply.author.name == "Aarav")
    }

    @Test func aMemberSeesPlanCardsAndCanvasCardsAndMayCommentOnAPlanWhenMessagingIsOn() async throws {
        let page = try #require(try await member(try Replay().serve("room-member-page-plan")).page(project: "pond-1"))
        var feed = RoomFeed()
        feed.apply(page: page)
        func lines(canPost: Bool) -> [RoomStatusLine] {
            RoomMessages.build(feed: feed, memberView: true, selfId: "someone", canMakeMemberTask: canPost)
                .compactMap { if case .system(let s) = $0 { s.status } else { nil } }
        }
        let on = lines(canPost: true)
        let plan = try #require(on.first { $0.kind == .plan })
        #expect(plan.isExpandable && plan.commentTarget == page.posts.first { $0.kind == .plan }?.id)
        #expect(on.first { $0.kind == .done }?.canvases.map(\.title) == ["Timer sketch"])
        // Messaging switched off: the card is read-only.
        #expect(lines(canPost: false).first { $0.kind == .plan }?.commentTarget == nil)
    }

    @Test func aMembersCommentOnAPlanIsQueuedWithItsCard() async throws {
        let t = try Replay().serve("room-member-comment-queued", status: 202)
        let queued = try await member(t).queue(pond: "pond-1", text: "Keep the manual override.", replyTo: "card-1")
        #expect(t.requests.first?.method == "POST" && t.requests.first?.url.path == "/native/ponds/pond-1/room")
        let sent = try #require(t.requests.first?.body)
        let body = NativeJSON.parse(String(decoding: sent, as: UTF8.self))
        #expect(body?["text"]?.string == "Keep the manual override." && body?["replyTo"]?.string == "card-1")
        #expect(queued.offline == false)
    }

    @Test func aCanvasCardWithoutAFolderStillDecodesAndAnOlderPageHasNoNewFields() throws {
        let json = #"{"posts":[{"seq":1,"id":"a","author":{"kind":"agent","name":"x"},"kind":"done","level":"room","text":"t","canvases":[{"id":"c","title":"T","kind":"deck","artboards":2}],"at":1},{"seq":2,"id":"b","author":{"kind":"agent","name":"x"},"kind":"working","level":"room","text":"t","at":2}],"latestSeq":2,"threads":[],"turns":[],"canPost":true}"#
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        #expect(page.posts[0].canvases.count == 1 && page.posts[1].canvases.isEmpty && page.posts[1].detail == nil && page.posts[1].replyTo == nil)
    }
}
