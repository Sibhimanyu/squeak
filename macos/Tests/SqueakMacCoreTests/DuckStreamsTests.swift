import Foundation
import Testing

@testable import SqueakMacCore

// A Duck's Streams (ADR 0003, ticket #96): decoding, the top bar's chips, the tooltip, the Changes grouping per Stream and
// the Room's Stream lines.

@Suite struct DuckStreamsTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(type, from: Data(json.utf8)) }

    @Test func aDuckAndAThreadDecodeTheirStreamsInJoinOrder() throws {
        let streams = #""streams":[{"workspaceId":"w1","branch":"feat/login","title":"Login"},{"workspaceId":"w2","branch":"fix/crash"}]"#
        let duck = try decode(PondDuck.self, #"{"id":"d1","name":"Pip",\#(streams)}"#)
        #expect(duck.streams.map(\.branch) == ["feat/login", "fix/crash"] && duck.streams[0].title == "Login" && duck.streams[1].title == nil)
        let thread = try decode(RoomThread.self, #"{"sessionId":"s1","title":"t",\#(streams)}"#)
        #expect(thread.streams.map(\.workspaceId) == ["w1", "w2"])
    }

    @Test func noStreamsOrABadEntryDecodesAsFewerNeverAnError() throws {
        #expect(try decode(PondDuck.self, #"{"id":"d1","name":"Pip"}"#).streams.isEmpty)
        let d = try decode(PondDuck.self, #"{"id":"d1","name":"Pip","streams":[{"branch":"x"},{"workspaceId":"w2","branch":"ok"}]}"#)
        #expect(d.streams.map(\.workspaceId) == ["w2"])
        #expect(try decode(RoomThread.self, #"{"sessionId":"s1","streams":"nope"}"#).streams.isEmpty)
    }

    @Test func streamsFlowFromTheHostDuckToTheRosterAndTheAvatar() throws {
        let duck = PondDuck(id: "d1", name: "Pip", currentSessionId: "s1", streams: [RoomStream(workspaceId: "w1", branch: "a")])
        let roster = RoomRoster.roster([duck])
        #expect(roster.open[0].streams.map(\.branch) == ["a"])
        let row = DuckAvatarRow.build(roster: roster, place: .dashboard)
        #expect(row.ducks[0].streams.map(\.branch) == ["a"])
    }

    @Test func chipsAreTheBranchesInOrderOrOnePondChip() {
        let chips = DuckStreams.chips([RoomStream(workspaceId: "w1", branch: "feat/login"), RoomStream(workspaceId: "w2", branch: "", title: "Crash")])
        #expect(chips.map(\.label) == ["feat/login", "Crash"] && chips.map(\.workspaceId) == ["w1", "w2"] && !chips[0].isPond)
        let none = DuckStreams.chips([])
        #expect(none.count == 1 && none[0].label == "Pond" && none[0].isPond && none[0].workspaceId == nil)
        #expect(DuckStreams.chipHelp(none[0]) != DuckStreams.chipHelp(chips[0]))
    }

    @Test func theTooltipListsEveryStreamWholeOrSaysPond() {
        let two = DuckStreams.tooltip(
            name: "Pip", presenceLine: "Working", streams: [RoomStream(workspaceId: "w1", branch: "feat/a-very-long-branch-name-indeed"), RoomStream(workspaceId: "w2", branch: "fix/b")])
        #expect(two == "Pip \u{00B7} Working\nIn 2 Streams\n\u{2022} feat/a-very-long-branch-name-indeed\n\u{2022} fix/b")
        #expect(DuckStreams.tooltip(name: "Pip", presenceLine: "Idle", streams: [RoomStream(workspaceId: "w1", branch: "a")]).contains("In 1 Stream\n"))
        #expect(DuckStreams.tooltip(name: "Pip", presenceLine: "Idle", streams: []) == "Pip \u{00B7} Idle\nIn the Pond")
    }
}

@Suite struct StreamChangesGroupingTests {
    private func session(_ id: String, duck: String?) -> HostSession {
        var s = HostSession(key: SessionKey(provider: "squeak", hostSessionId: id), lastActivityAt: Date(timeIntervalSince1970: 1000))
        s.duckId = duck
        return s
    }

    // Pip is in two Streams (two entries, as the host sends them), Moss in one, Ivy's second Stream has nothing changed.
    private let json = #"""
    {"projectId":"p1",
     "main":{"branch":"main","files":[{"path":"m.txt","status":"M","added":1,"removed":0}],"totals":{"added":1,"removed":0,"files":1}},
     "ducks":[
       {"duckId":"d1","duckName":"Pip","branch":"feat/login","workspaceId":"w1","files":[{"path":"a.txt","status":"M","added":1,"removed":0}],"totals":{"added":1,"removed":0,"files":1}},
       {"duckId":"d2","duckName":"Moss","branch":"sq/moss","workspaceId":"w3","files":[{"path":"c.txt","status":"A","added":2,"removed":0}],"totals":{"added":2,"removed":0,"files":1}},
       {"duckId":"d1","duckName":"Pip","branch":"fix/crash","workspaceId":"w2","files":[{"path":"b.txt","status":"A","added":2,"removed":0}],"totals":{"added":2,"removed":0,"files":1}},
       {"duckId":"d4","duckName":"Ivy","branch":"x","workspaceId":"w4","files":[],"totals":{"added":0,"removed":0,"files":0}}],
     "ducksTruncated":false}
    """#

    private func sections() throws -> [RailChangeSection] {
        let changes = try JSONDecoder().decode(HostPondChanges.self, from: Data(json.utf8))
        return RailChanges.pondSections(changes, sessions: [session("s1", duck: "d1")], mainSessionKey: "squeak:main")
    }

    @Test func aDucksStreamsSitTogetherThenMain() throws {
        let s = try sections()
        #expect(s.map(\.branch) == ["feat/login", "fix/crash", "sq/moss", "main"])
        #expect(s.map(\.title) == ["Pip", "Pip", "Moss", "Main"])
        #expect(s.map(\.continuesDuck) == [false, true, false, false])
        #expect(s.map(\.streamCount) == [2, 2, 1, 1])
        #expect(Set(s.map(\.id)).count == s.count)
    }

    @Test func reviewAllNamesTheStreamOnlyWhenTheDuckHasSeveral() throws {
        let s = try sections()
        #expect(s[0].reviewAllLabel == "Review all from Pip on feat/login" && s[1].reviewAllLabel == "Review all from Pip on fix/crash")
        #expect(s[2].reviewAllLabel == nil) // Moss has no chat on this Mac
    }

    @Test func aChipNarrowsTheListToItsStreamAndThePondChipToMain() throws {
        let s = try sections()
        #expect(RailChanges.narrowed(s, duckId: "d1", filter: nil).map(\.branch) == ["feat/login", "fix/crash"])
        #expect(RailChanges.narrowed(s, duckId: "d1", filter: .stream("w2")).map(\.branch) == ["fix/crash"])
        #expect(RailChanges.narrowed(s, duckId: "d1", filter: .stream("w3")).isEmpty) // another Duck's Stream is not Pip's
        #expect(RailChanges.narrowed(s, duckId: "d1", filter: .pond).map(\.title) == ["Main"])
    }

    @Test func theFilterLineNamesWhatIsShown() {
        let streams = [RoomStream(workspaceId: "w2", branch: "fix/crash")]
        #expect(RailChanges.filterLine(nil, streams: streams) == nil)
        #expect(RailChanges.filterLine(.stream("w2"), streams: streams) == "Showing fix/crash")
        #expect(RailChanges.filterLine(.pond, streams: streams) == "Showing the Pond\u{2019}s own folder")
    }
}

@Suite struct StreamRoomLinesTests {
    private let base: Int64 = 1_700_000_000_000

    private func post(_ seq: Int, _ text: String, kind: RoomAuthorKind = .squeak) throws -> RoomPost {
        let k = kind == .squeak ? "squeak" : "agent"
        let json = #"{"seq":\#(seq),"id":"p\#(seq)","author":{"kind":"\#(k)","name":"Pip"},"sessionId":"s1","kind":"message","level":"room","text":"\#(text)","at":\#(base + Int64(seq))}"#
        return try JSONDecoder().decode(RoomPost.self, from: Data(json.utf8))
    }

    private func lines(_ posts: [RoomPost]) -> [RoomSystemLine] {
        var feed = RoomFeed()
        feed.apply(page: RoomPage(
            posts: posts, latestSeq: posts.map(\.seq).max() ?? 0, threads: [RoomThread(sessionId: "s1", title: "Pip", state: .idle, name: "Pip")], turns: [], tasks: nil))
        return RoomMessages.build(feed: feed, now: Date(timeIntervalSince1970: Double(base) / 1000)).compactMap { if case .system(let l) = $0 { l } else { nil } }
    }

    @Test func createdJoinedAndLeftAreCompactMomentLinesThatOpenTheDuck() throws {
        let out = lines([try post(1, "joined Stream Login"), try post(2, "created Stream Crash"), try post(3, "left Stream Login")])
        #expect(out.map(\.text) == ["Pip joined Stream Login", "Pip created Stream Crash", "Pip left Stream Login"])
        #expect(out.allSatisfy { $0.opens == "s1" && $0.status?.kind == .stream })
        #expect(RoomMoment.line(name: "Pip", verb: out[0].status!.verb, summary: out[0].status!.summary) == "Pip joined Stream Login")
    }

    @Test func otherThingsSqueakSaysStayOutOfTheRoom() throws {
        #expect(lines([try post(1, "something else"), try post(2, "joined Stream ")]).isEmpty)
        #expect(lines([try post(1, "joined Stream Login", kind: .agent)]).first?.status?.kind != .stream)
    }
}
