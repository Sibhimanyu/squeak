import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Pond room feed")
struct RoomFeedTests {
    private func post(_ seq: Int, _ text: String = "t", kind: RoomPostKind = .working, level: RoomLevel = .room, by: RoomAuthor? = nil, at: Int64? = nil, to: String? = nil) -> RoomPost {
        RoomPost(seq: seq, id: "p\(seq)", author: by ?? RoomAuthor(kind: .agent, id: "a1", name: "Claude"), kind: kind, level: level, text: text, toSessionId: to, at: at ?? Int64(seq) * 1000)
    }
    private let me = RoomAuthor(kind: .person, name: "Me")

    @Test func decodesLeniently() throws {
        let json = """
        {"posts":[{"seq":1,"id":"a","author":{"kind":"robot","name":"X"},"kind":"zzz","level":"zzz","text":"hi","at":5,"extra":1},{"nope":true}],
         "latestSeq":1,"threads":[{"sessionId":"s","title":"T","state":"flying"}]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        #expect(page.posts.count == 1)
        #expect(page.posts[0].kind == .message && page.posts[0].level == .room && page.posts[0].author.kind == .agent)
        #expect(page.threads[0].state == .idle)
    }

    @Test func decodesTheTurnAndTheFallbackFlagWhenSentAndIgnoresThemWhenNot() throws {
        let json = """
        {"posts":[{"seq":1,"id":"a","author":{"kind":"agent","name":"Kit"},"text":"hi","at":5,"turnId":"t4","fallback":true},
                  {"seq":2,"id":"b","author":{"kind":"agent","name":"Kit"},"text":"yo","at":6,"turnId":"","fallback":"yes"},
                  {"seq":3,"id":"c","author":{"kind":"agent","name":"Kit"},"text":"old host","at":7}],"latestSeq":3,"threads":[]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        #expect(page.posts[0].turnId == "t4" && page.posts[0].fallback)
        #expect(page.posts[1].turnId == nil && !page.posts[1].fallback)
        #expect(page.posts[2].turnId == nil && !page.posts[2].fallback)
    }

    @Test func idempotentBySeq() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [post(1), post(2)], latestSeq: 2))
        f.apply(page: RoomPage(posts: [post(2), post(1)], latestSeq: 2))
        #expect(f.rows.map(\.id) == ["p1", "p2"])
        #expect(f.receive(post(2)) == .none)
        #expect(f.rows.count == 2)
    }

    @Test func appendOnlyAndGapRefetches() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [post(1)], latestSeq: 1))
        #expect(f.receive(post(2)) == .none)
        #expect(f.receive(post(5)) == .refetch(since: 2))
        #expect(f.rows.map(\.post.seq) == [1, 2])
        f.apply(page: RoomPage(posts: [post(3), post(4), post(5)], latestSeq: 5))
        #expect(f.rows.map(\.post.seq) == [1, 2, 3, 4, 5])
        #expect(f.hello(latestSeq: 9) == .refetch(since: 5))
    }

    @Test func prependOlderKeepsRows() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [post(5), post(6)], latestSeq: 6), pageSize: 2)
        #expect(f.hasMoreBefore)
        f.prepend(page: RoomPage(posts: [post(3), post(4), post(5)], latestSeq: 6), pageSize: 3)
        #expect(f.rows.map(\.post.seq) == [3, 4, 5, 6])
    }

    @Test func pendingReconcilesOnceUnderItsOwnId() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [post(1)], latestSeq: 1))
        let id = f.addPending(text: "hello", level: .room, author: me, at: 10)
        // Another post lands first: pending stays last.
        _ = f.receive(post(2))
        #expect(f.rows.map(\.id) == ["p1", "p2", id])
        f.reconcile(pendingId: id, with: RoomPost(seq: 3, id: "p3", author: me, text: "hello", at: 11))
        #expect(f.rows.count == 3)
        #expect(f.rows.last?.id == id && f.rows.last?.pending == false && f.rows.last?.post.seq == 3)
    }

    @Test func streamBeatsPostResponse() {
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [post(1)], latestSeq: 1))
        let id = f.addPending(text: "hello", level: .room, author: me, at: 10)
        let real = RoomPost(seq: 2, id: "p2", author: me, text: "hello", at: 11)
        _ = f.receive(real)
        #expect(f.rows.count == 2 && f.rows.last?.id == id)
        f.reconcile(pendingId: id, with: real)
        #expect(f.rows.count == 2)
    }

    @Test func groupsByAuthorWithinThreeMinutes() {
        let rows = [post(1, at: 0), post(2, at: 60_000), post(3, at: 60_000 + 200_000), post(4, by: me, at: 300_000)]
            .map { RoomRow(id: $0.id, post: $0, pending: false, failed: false) }
        let g = RoomGrouping.groups(rows, filter: RoomFilter())
        #expect(g.map { $0.rows.count } == [2, 1, 1])
        #expect(g.first?.id == "p1")
    }

    @Test func filterHidesAgentTalkByDefault() {
        let rows = [post(1), post(2, level: .agents), post(3)].map { RoomRow(id: $0.id, post: $0, pending: false, failed: false) }
        #expect(RoomGrouping.groups(rows, filter: RoomFilter()).flatMap(\.rows).map(\.id) == ["p1", "p3"])
        #expect(RoomGrouping.groups(rows, filter: RoomFilter(showAgentTalk: true)).flatMap(\.rows).count == 3)
    }

    @Test func presentation() {
        #expect(RoomPresentation.kindLabel(post(1, kind: .needs)) == .init(text: "needs you", attention: true))
        #expect(RoomPresentation.kindLabel(post(1, kind: .message)) == nil)
        let t = RoomThread(sessionId: "s", title: "Fix login", state: .working)
        #expect(RoomPresentation.recipient(post(1, to: "s"), threads: [t]) == "to Fix login")
        #expect(RoomPresentation.initials("Sibhi M") == "SM")
        #expect(RoomPresentation.relativeTime(at: 0, now: Date(timeIntervalSince1970: 300)) == "5m")
        #expect(RoomPresentation.chipLine(t) == "Working")
        #expect(RoomPresentation.workingNow([t, RoomThread(sessionId: "i", title: "x", state: .idle)]).count == 1)
    }

    @Test func queryString() {
        #expect(RoomClient.query(since: 4, before: nil, limit: 50) == "?since=4&limit=50")
    }

    @Test func recentList() {
        let now = Date(timeIntervalSince1970: 100_000)
        let ms = { (s: Int) in Int64((100_000 - s) * 1000) }
        let a = RoomThread(sessionId: "a", title: "A", state: .idle, lastState: "finished", lastAt: ms(840))
        let b = RoomThread(sessionId: "b", title: "B", state: .idle, lastState: "stopped", lastAt: ms(7_300))
        let c = RoomThread(sessionId: "c", title: "C", state: .error, lastState: "error", lastAt: ms(20))
        let w = RoomThread(sessionId: "w", title: "W", state: .working, lastState: "finished", lastAt: ms(1))
        let n = RoomThread(sessionId: "n", title: "N", state: .idle)
        #expect(RoomPresentation.recent([b, w, a, c, n]).map(\.sessionId) == ["c", "a", "b", "n"])
        #expect(RoomPresentation.recentLine(a, now: now) == "finished 14m ago")
        #expect(RoomPresentation.recentLine(b, now: now) == "stopped 2h ago")
        #expect(RoomPresentation.recentLine(c, now: now) == "hit an error just now")
        #expect(RoomPresentation.recentLine(n, now: now) == "idle")
    }
}
