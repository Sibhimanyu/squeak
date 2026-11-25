import Foundation
import Testing
@testable import SqueakMacCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func chat(_ id: String, state: SessionState = .idle) -> HostSession {
    HostSession(
        key: SessionKey(provider: "squeak", hostSessionId: id), title: id, repoName: "p", branch: nil, cwd: "/w/\(id)", state: state,
        lastActivityAt: t0, workspaceName: "ws-\(id)")
}

@Suite("Pond dashboard counts")
struct PondCountsTests {
    /// The host's roster for the five chats: a, e working (e is off duty), b needs you, c and d idle (d off duty).
    private func layout() -> PondHomeLayout {
        let chats = [chat("a", state: .working), chat("b", state: .blocked), chat("c"), chat("d"), chat("e", state: .working)]
        func duck(_ id: String, _ activity: PondDuckActivity, off: Bool = false) -> PondDuck {
            var d = PondDuck(id: "duck-\(id)", name: id.uppercased(), duty: off ? .off : .on, currentSessionId: id)
            d.activity = activity
            return d
        }
        let ducks = [duck("a", .working), duck("b", .needsYou), duck("c", .idle), duck("d", .idle, off: true), duck("e", .working, off: true)]
        return PondHomeLayout.buildRoster(ducks: ducks, sessions: chats, detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
    }

    @Test func tilesCountExactlyTheListedRows() {
        let l = layout()
        #expect(l.dutyCount == 5)
        #expect(l.count(in: .onDuty) == 3 && l.count(in: .offDuty) == 2 && l.count(in: .working) == 1 && l.count(in: .needsYou) == 1)
    }

    @Test func sentCountsWinAndTilesFilterByDuty() {
        let l = layout()
        let sent = PondCounts(onDuty: 9, working: 8, needsYou: 7, offDuty: 6, total: 15)
        #expect(sent.count(.offDuty) == 6)
        #expect(PondCounts.secondary(.offDuty, sent) == "15 in all")
        #expect(PondCounts.secondary(.onDuty, sent) == nil)
        #expect(PondDashboardScope.tiles == [.onDuty, .working, .needsYou, .offDuty])
        #expect(l.count(in: .onDuty) == 3 && l.count(in: .offDuty) == 2 && l.count(in: .working) == 1)
    }

    @Test func decodesFromTheRosterBodyAndAnOldDaemonWithout() throws {
        struct R: Decodable { var counts: PondCounts? }
        let json = #"{"counts":{"onDuty":2,"working":1,"needsYou":0,"offDuty":1,"total":3}}"#
        #expect(try JSONDecoder().decode(R.self, from: Data(json.utf8)).counts == PondCounts(onDuty: 2, working: 1, needsYou: 0, offDuty: 1, total: 3))
        #expect(try JSONDecoder().decode(R.self, from: Data("{}".utf8)).counts == nil)
    }
}
