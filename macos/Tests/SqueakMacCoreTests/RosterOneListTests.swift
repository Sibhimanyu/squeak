import Foundation
import Testing
@testable import SqueakMacCore

/// The owner's greenroom contradictions (2026-11-25, captured from the live `GET /native/projects/<id>/ducks`): the tiles said
/// "On duty 2, 25 in all" while the list said "4 of 27", Pickle was Working in the list and Idle on its tab, Dhol read "main" in
/// the list and "sibhimanyu/hi" in the subheader, and a nameless "Unreleased items" import showed On duty. One roster now feeds all.
@Suite("One Pond roster")
struct RosterOneListTests {
    private let body = #"""
    {"ducks":[
     {"id":"d-pickle","projectId":"p","name":"Pickle","chatTitle":"Fix Bugs Using Ducklings","colourSeed":"s-pickle","duty":"on","currentSessionId":"s-pickle",
      "streams":[{"workspaceId":"w1","branch":"sibhimanyu/i-have-a-list-of-bugs","title":"Silver Turtle"}],"streamLabels":["sibhimanyu/i-have-a-list-of-bugs"],
      "state":"working","activity":"working","ducklingsRunning":1,"statusLine":"Working · 1 duckling on audit","heading":"Pickle","lastActiveAt":1795611167070},
     {"id":"d-dhol","projectId":"p","name":"Dhol","chatTitle":"Branch Setup","colourSeed":"s-dhol","duty":"on","currentSessionId":"s-dhol",
      "streams":[{"workspaceId":"w2","branch":"sibhimanyu/hi","title":"Lily Salamander"}],"streamLabels":["sibhimanyu/hi"],
      "state":"idle","activity":"idle","ducklingsRunning":0,"statusLine":"Idle · 4m","heading":"Dhol","lastActiveAt":1795610823857},
     {"id":"d-ruby","projectId":"p","name":"Zoom SDK","lastName":"Ruby 2","chatTitle":"Zoom SDK","colourSeed":"s-ruby","duty":"off","currentSessionId":"s-ruby",
      "streamLabels":["Pond"],"state":"error","activity":"error","ducklingsRunning":0,"statusLine":"off duty 3d ago","heading":"Zoom SDK","lastActiveAt":1795595728351},
     {"id":"d-unreleased","projectId":"p","chatTitle":"Unreleased items","colourSeed":"s-un","duty":"off","currentSessionId":"s-un",
      "streamLabels":["Pond"],"state":"idle","activity":"idle","ducklingsRunning":0,"statusLine":"off duty 30d ago","heading":"Unreleased items","lastActiveAt":1793000000000}
    ],
    "counts":{"onDuty":2,"working":1,"needsYou":0,"offDuty":2,"total":4}}
    """#

    private struct Reply: Decodable {
        var ducks: [PondDuck]
        var counts: PondCounts
        init(from decoder: Decoder) throws {
            struct Lossy: Decodable { var d: PondDuck?; init(from decoder: Decoder) throws { d = try? PondDuck(from: decoder) } }
            let c = try decoder.container(keyedBy: Keys.self)
            ducks = try c.decode([Lossy].self, forKey: .ducks).compactMap(\.d)
            counts = try c.decode(PondCounts.self, forKey: .counts)
        }
        enum Keys: String, CodingKey { case ducks, counts }
    }

    private func reply() throws -> Reply { try JSONDecoder().decode(Reply.self, from: Data(body.utf8)) }

    private func chat(_ id: String) -> HostSession {
        HostSession(key: SessionKey(provider: "squeak", hostSessionId: id), title: id, repoName: "p", branch: "main", cwd: "/w", state: .idle,
                    lastActivityAt: Date(), workspaceName: "w")
    }

    @Test func tilesListAndHeaderAreTheSameRows() throws {
        let r = try reply()
        let l = PondHomeLayout.buildRoster(ducks: r.ducks, sessions: ["s-pickle", "s-dhol", "s-ruby", "s-un"].map(chat), detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        #expect(l.dutyCount == r.counts.total)
        for scope in PondDashboardScope.tiles { #expect(l.count(in: scope) == r.counts.count(scope), "\(scope.title)") }
        #expect(l.filtered(query: "", scope: .onDuty).dutyCount == r.counts.onDuty)
    }

    @Test func aDuckWithDucklingsWorkingIsWorkingInTheListAndOnItsTab() throws {
        let r = try reply()
        let roster = RoomRoster.roster(r.ducks)
        let pickle = try #require(roster.onDuty.first { $0.id == "d-pickle" })
        #expect(pickle.presence == .working && pickle.presenceLine == "Working \u{00B7} 1 duckling on audit")
        let tab = DuckAvatarRow.build(roster: roster, place: .dashboard).ducks.first { $0.id == "d-pickle" }
        #expect(tab?.presence == .working)
        #expect(PondTabStatus.line(for: try #require(tab)).hasPrefix("Working"))
        let l = PondHomeLayout.buildRoster(ducks: r.ducks, sessions: [chat("s-pickle")], detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        let row = try #require(l.threads.first { $0.duckId == "d-pickle" })
        #expect(row.state == .working && PondDashboardScope.working.includes(row))
    }

    @Test func streamsAreTheHostsLabelsInTheListAndTheSubheader() throws {
        let r = try reply()
        let l = PondHomeLayout.buildRoster(ducks: r.ducks, sessions: [chat("s-dhol")], detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        let row = try #require(l.threads.first { $0.duckId == "d-dhol" })
        #expect(row.streamLabels == ["sibhimanyu/hi"])
        let dhol = try #require(r.ducks.first { $0.id == "d-dhol" })
        #expect(DuckStreams.chips(dhol.streams).map(\.label) == row.streamLabels)
        #expect(try #require(l.threads.first { $0.duckId == "d-ruby" }).streamLabels == ["Pond"])
    }

    @Test func aNamelessClosedImportStaysOffDutyWithItsTitle() throws {
        let r = try reply()
        let l = PondHomeLayout.buildRoster(ducks: r.ducks, sessions: [], detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        let row = try #require(l.threads.first { $0.duckId == "d-unreleased" })
        #expect(!row.onDuty && row.heading == "Unreleased items" && row.statusLine == "off duty 30d ago")
        #expect(l.count(in: .onDuty) == 2 && l.count(in: .offDuty) == 2)
    }

    @Test func aCloudThreadMatchesADuckOrWaitsUncountedInTheFlock() throws {
        let r = try reply()
        let json = #"{"pond":{"id":"a","name":"g"},"members":[{"id":"m","name":"Me"}],"threads":[{"id":"t1","title":"Mine","sessionId":"s-dhol"},{"id":"t2","title":"Elsewhere"}]}"#
        let detail = try JSONDecoder().decode(PondDetail.self, from: Data(json.utf8))
        let l = PondHomeLayout.buildRoster(ducks: r.ducks, sessions: [], detail: detail, me: "Me", hostIdFor: { $0.key.hostSessionId })
        #expect(l.dutyCount == 4)
        #expect(l.fromFlock.map(\.title) == ["Elsewhere"] && l.fromFlock.allSatisfy(\.isFlock))
        #expect(l.threads.first { $0.duckId == "d-dhol" }?.pondThread == "t1")
        #expect(l.count(in: .onDuty) == 2 && l.count(in: .all) == 5)
    }
}
