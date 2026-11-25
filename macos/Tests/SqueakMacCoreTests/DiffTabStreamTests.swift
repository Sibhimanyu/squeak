import Foundation
import SqueakMacCore
import Testing

/// A diff or review tab carries the Stream it reads (ADR 0003: a Duck's chat folder is the Pond's, not the Stream's).
@Suite struct DiffTabStreamTests {
    private let login = TabStream(workspaceId: "ws-login", branch: "sq/login")
    private let fix = TabStream(workspaceId: "ws-fix", branch: "sq/fix")

    @Test func theSameFileInTwoStreamsIsTwoTabs() {
        let a = TabItem.diff(session: "chat", path: "A.swift", stream: login)
        let b = TabItem.diff(session: "chat", path: "A.swift", stream: fix)
        #expect(a != b)
        #expect(a == .diff(session: "chat", path: "A.swift", stream: login))
        #expect(TabItem.reviewAll(session: "chat", stream: login) != .reviewAll(session: "chat", stream: fix))
        #expect(a != .diff(session: "chat", path: "A.swift"))
    }

    @Test func theSourceCarriesTheStream() {
        let d = TabItem.diff(session: "chat", path: "A.swift", stream: login)
        #expect(d.diffSource?.stream == login)
        #expect(d.diffSource?.path == "A.swift")
        #expect(TabItem.reviewAll(session: "chat", stream: fix).diffSource?.stream == fix)
        #expect(TabItem.duck("x").diffSource == nil)
    }

    @Test func everyReaderRoutesByTheStream() {
        #expect(DiffRoute(TabItem.diff(session: "chat", path: "A", stream: login)) == .stream(workspaceId: "ws-login"))
        #expect(DiffRoute(TabItem.reviewAll(session: "chat", stream: fix)) == .stream(workspaceId: "ws-fix"))
        #expect(DiffRoute(TabItem.duck("x")) == nil)
        // Two Streams of one Duck never share a read cache, nor with the chat's own.
        #expect(Set([DiffRoute.stream(workspaceId: "ws-login").cacheKey, DiffRoute.stream(workspaceId: "ws-fix").cacheKey,
                     DiffRoute.chat(sessionKey: "chat").cacheKey]).count == 3)
    }

    @Test func aTabWithoutAStreamReadsThroughTheChat() {
        #expect(DiffRoute(TabItem.diff(session: "chat", path: "A")) == .chat(sessionKey: "chat"))
        #expect(DiffRoute(session: "chat", stream: TabStream(workspaceId: "", branch: "x")) == .chat(sessionKey: "chat"))
    }

    @Test func persistedTabsRoundTripAndOldOnesDecodeWithoutAStream() throws {
        let item = TabItem.reviewAll(session: "chat", stream: login)
        let back = try JSONDecoder().decode(TabItem.self, from: JSONEncoder().encode(item))
        #expect(back == item)
        #expect(back.diffSource?.stream == login)
        // Saved before Streams: only kind and id.
        let old = try JSONDecoder().decode(TabItem.self, from: Data(#"{"kind":"diff","id":"chat\u001FA.swift"}"#.utf8))
        #expect(old.stream == nil)
        #expect(old.diffSource?.path == "A.swift")
        #expect(DiffRoute(old) == .chat(sessionKey: "chat"))
        #expect(old == .diff(session: "chat", path: "A.swift"))
    }

    @Test func aDiffOpenedWithoutAStreamPicksTheDucksOwn() {
        let streams = [RoomStream(workspaceId: "ws-login", branch: "sq/login"), RoomStream(workspaceId: "ws-fix", branch: "sq/fix")]
        #expect(TabStream.resolve(streams: [], changedPaths: [:], path: "A") == nil)
        #expect(TabStream.resolve(streams: [streams[1]], changedPaths: [:], path: "A") == fix)
        #expect(TabStream.resolve(streams: streams, changedPaths: ["ws-fix": ["A"], "ws-login": ["B"]], path: "A") == fix)
        #expect(TabStream.resolve(streams: streams, changedPaths: [:], path: "A") == login)
        #expect(TabStream.resolve(streams: streams, changedPaths: ["ws-fix": ["A"]], path: nil) == login)
    }

    @Test func askNamesTheStreamTheDuckWorksIn() {
        let h = DiffTabHeader(duck: "Pip", branch: "sq/login", path: "A.swift", streamBranch: "sq/login")
        #expect(h.askMessage("rename") == "In the stream sq/login: About A.swift:\nrename")
        let all = DiffTabHeader(duck: "Pip", branch: "sq/login", path: nil, fileCount: 2, streamBranch: " sq/login ")
        #expect(all.askMessage("tighten") == "In the stream sq/login: tighten")
        // No Stream: unchanged.
        #expect(DiffTabHeader(duck: "Pip", branch: "b", path: nil).askMessage("x") == "x")
    }
}
