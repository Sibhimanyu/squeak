import Foundation
import Testing
@testable import SqueakMacCore

/// A chat repeating a failing step is under Needs you everywhere, by one rule, until the flag clears.
@Suite struct LoopingNeedsYouTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func chat(_ id: String, state: SessionState = .working, loop: Bool, alive: Bool? = true) -> HostSession {
        var s = HostSession(key: SessionKey(provider: "squeak", hostSessionId: id), title: id, repoName: "p", branch: id, cwd: "/w/\(id)",
                            agent: "claude", state: state, lastActivityAt: now.addingTimeInterval(-30), alive: alive, workspaceName: "ws-\(id)")
        if loop { s.looping = DaemonLoop(label: "Run npm test", count: 4) }
        return s
    }

    @Test func groupingBoardMarkAndPondStateAgree() {
        let l = chat("l", loop: true)
        #expect(SessionGrouping.kind(of: l, now: now) == .needsYou)
        #expect(DashboardBoard.lane(for: SidebarWorkspace(id: "w", name: "w", branch: "l", chats: [l]), now: now) == .needsYou)
        #expect(ChatMark.of(l, unread: false, now: now) == ChatMark(.waiting, waiting: .looping))
        #expect(ChatMark(.waiting, waiting: .looping).words == "Repeating a failing step")
        #expect(PondThreadState(l) == .needsYou)
        #expect(l.loopingSentence == "Repeating a failing step: Run npm test ×4")
    }

    @Test func itLeavesNeedsYouWhenTheFlagClearsOrTheChatStops() {
        #expect(SessionGrouping.kind(of: chat("a", loop: false), now: now) == .working)
        #expect(ChatMark.of(chat("a", loop: false), unread: false, now: now) == ChatMark(.working))
        #expect(PondThreadState(chat("a", loop: false)) == .working)
        let finished = chat("b", state: .finished, loop: true)
        #expect(!finished.isLoopingNow)
        #expect(SessionGrouping.kind(of: finished, now: now) == .done)
        #expect(SessionGrouping.kind(of: chat("c", loop: true, alive: false), now: now) == .idle)
        #expect(chat("c", loop: false).loopingSentence == nil)
    }

    @Test func thePondOverviewCountsItUnderNeedsYouAndTheRowCarriesTheSentence() {
        let l = chat("l", loop: true), w = chat("w", loop: false)
        let project = SidebarTreeBuilder.build([l, w], now: now).projects[0]
        let layout = PondHomeLayout.build(project: project, detail: nil, me: "Me", hostIdFor: { $0.key.hostSessionId })
        #expect(layout.count(in: .needsYou) == 1)
        #expect(layout.count(in: .working) == 1)
        let row = layout.workspaces.flatMap(\.chats).first { $0.id == l.key.stringValue }
        #expect(row?.isLooping == true)
        #expect(row?.loopSentence == "Repeating a failing step: Run npm test ×4")
        #expect(layout.workspaces.flatMap(\.chats).first { $0.id == w.key.stringValue }?.isLooping == false)
    }

    @Test func thePanelListsItAmongTheThreadsWaitingOnYou() {
        func fact(_ s: HostSession) -> PondThreadFact { PondThreadFact(key: s.key, title: s.title, state: s.state, lastActivityAt: s.lastActivityAt, looping: s.isLoopingNow) }
        let waiting = PondOrdering.needsYou([fact(chat("l", loop: true)), fact(chat("w", loop: false))])
        #expect(waiting.map(\.title) == ["l"])
    }
}
