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
    private func layout(off: Set<String> = []) -> PondHomeLayout {
        let chats = [chat("a", state: .working), chat("b", state: .blocked), chat("c"), chat("d"), chat("e", state: .working)]
        let p = SidebarTreeBuilder.build(chats, now: t0).projects[0]
        return PondHomeLayout.build(project: p, detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId }, offDutySessions: off)
    }

    @Test func fallbackCountsLikeTheDaemon() {
        let l = layout(off: ["d", "e"])
        let c = PondCounts.fallback(rows: l.threads)
        #expect(c == PondCounts(onDuty: 3, working: 1, needsYou: 1, offDuty: 2, total: 5))
    }

    @Test func sentCountsWinAndTilesFilterByDuty() {
        let l = layout(off: ["d", "e"])
        let sent = PondCounts(onDuty: 9, working: 8, needsYou: 7, offDuty: 6, total: 15)
        #expect(PondCounts.resolve(sent, rows: l.threads) == sent)
        #expect(PondCounts.resolve(nil, rows: l.threads).onDuty == 3)
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
