import Foundation
import Testing
@testable import SqueakMacCore

private func s(_ id: String, _ title: String, repo: String? = nil, cwd: String? = nil, state: SessionState = .finished,
               ago: TimeInterval? = 60, now: Date) -> HostSession {
    HostSession(key: SessionKey(provider: "conductor", hostSessionId: id), title: title, repoName: repo, cwd: cwd,
                state: state, lastActivityAt: ago.map { now.addingTimeInterval(-$0) }, alive: true)
}

@Suite("Home projects")
struct HomeProjectsTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func newestProjectFirstAndBlockedDoesNotJump() {
        let list = [
            s("1", "old blocked", repo: "alpha", state: .blocked, ago: 3000, now: now),
            s("2", "fresh", repo: "beta", ago: 10, now: now),
            s("3", "mid", repo: "alpha", ago: 500, now: now),
        ]
        let p = HomeProjects.build(list, now: now)
        #expect(p.map(\.name) == ["beta", "alpha"])
        #expect(p[1].sessions.map(\.title) == ["mid", "old blocked"])
        #expect(p[1].needsYouCount == 1)
    }

    @Test func ties_byTitle_andFolderFallback() {
        let list = [
            s("1", "Zed", repo: "r", ago: 5, now: now), s("2", "alpha", repo: "r", ago: 5, now: now),
            s("3", "x", cwd: "/Users/me/code/thing", ago: 1, now: now), s("4", "y", ago: 2, now: now),
        ]
        let p = HomeProjects.build(list, now: now)
        #expect(p.map(\.name) == ["thing", "Other", "r"])
        #expect(p[2].sessions.map(\.title) == ["alpha", "Zed"])
    }

    @Test func projectPage_groupsByStatusNewestFirst_andCounts() throws {
        let list = [
            s("1", "old done", repo: "alpha", state: .finished, ago: 900, now: now),
            s("2", "new done", repo: "alpha", state: .finished, ago: 100, now: now),
            s("3", "busy", repo: "alpha", state: .working, ago: 50, now: now),
            s("4", "blocked", repo: "alpha", state: .blocked, ago: 4000, now: now),
            s("5", "elsewhere", repo: "beta", state: .working, ago: 5, now: now),
        ]
        let page = try #require(HomeProjects.page(named: "alpha", in: list, now: now))
        #expect(page.sections.map(\.kind) == [.needsYou, .done, .working])
        #expect(page.sections[1].sessions.map(\.title) == ["new done", "old done"])
        #expect(page.sessionCount == 4 && page.workingCount == 1)
        #expect(page.summary == "4 sessions · 1 working")
        #expect(HomeProjects.page(named: "gone", in: list, now: now) == nil)
    }

    @Test func earlierIdleLeavesCardsAndSearchSplits() {
        let old = s("9", "ancient", repo: "r", state: .idle, ago: 3 * 86400, now: now)
        let fresh = s("8", "fresh", repo: "r", ago: 5, now: now)
        #expect(HomeProjects.build([old, fresh], now: now).first?.sessions.count == 1)
        let hits = [old, fresh].map { SearchHit(key: $0.key, titleMatch: true, messageId: nil, snippet: nil) }
        let sp = HomeSearch.split(hits, sessions: [old, fresh], now: now)
        #expect(sp.active.map(\.key) == [fresh.key])
        #expect(sp.earlier.map(\.key) == [old.key])
    }

    @Test func statusStrip() {
        #expect(MacStatusStrip.items(awake: nil, power: nil, connected: true).isEmpty)
        let off = MacStatusStrip.items(awake: nil, power: DaemonPower(mode: "low"), connected: false)
        #expect(off.map(\.text) == ["Offline", "Low Power"])
        let on = MacStatusStrip.items(awake: DaemonAwake(until: nil, lid: true, lowPower: false), power: DaemonPower(mode: "auto"), connected: true)
        #expect(on.map(\.text) == ["Awake until you end it · lid closed"])
    }
}
