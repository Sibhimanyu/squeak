import Testing
import Foundation
@testable import SqueakMacCore

@Suite struct PondGlanceTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static func ago(_ s: TimeInterval) -> Date { now.addingTimeInterval(-s) }
    static func key(_ id: String) -> SessionKey { SessionKey(provider: "squeak", hostSessionId: id) }

    static func thread(_ id: String, by: String, byName: String, state: String, at: TimeInterval, session: String? = nil) -> PondThread {
        var t = PondThread(id: id, title: "T \(id)", starter: by, starterName: byName, state: state, isPrivate: false, updatedAt: ago(at))
        t.sessionId = session
        return t
    }

    static func detail() -> PondDetail {
        PondDetail(
            pond: PondSummary(id: "p", name: "Site"),
            members: [FlockMember(id: "me", name: "Sib", role: .owner, online: true, you: true),
                      FlockMember(id: "a", name: "Aarav", online: true),
                      FlockMember(id: "b", name: "Bea", online: false, lastSeenAt: ago(7200)),
                      FlockMember(id: "c", name: "Cy", online: true)],
            threads: [thread("1", by: "a", byName: "Aarav", state: "working", at: 60),
                      thread("2", by: "a", byName: "Aarav", state: "working", at: 120),
                      thread("3", by: "me", byName: "Sib", state: "awaiting_answer", at: 300, session: "s3"),
                      thread("4", by: "b", byName: "Bea", state: "working", at: 30),
                      thread("5", by: "c", byName: "Cy", state: "finished", at: 10)],
            ripples: (1...8).map { RippleEntry(id: "r\($0)", at: ago(Double($0) * 100), actorName: "Aarav", text: "Aarav started T\($0)") })
    }

    @Test func peopleMostActiveFirstThenNeedsThenOnlineThenYouThenName() {
        let g = PondGlance.build(detail: Self.detail(), local: [], youName: "Sib", now: Self.now)
        #expect(g.people.map(\.name) == ["Aarav", "Bea", "Sib", "Cy"])
        #expect(g.people[0].line == "2 threads working")
        #expect(g.people[1].line == "Working on T 4")
        #expect(g.people[2].line == "1 thread needs them")
        #expect(g.people[3].line == "Online")
        #expect(g.people.first { $0.name == "Sib" }?.you == true)
    }

    @Test func nowListsNeedsYouFirstThenWorkingNewestFirstWithOwners() {
        let g = PondGlance.build(detail: Self.detail(), local: [], youName: "Sib", now: Self.now)
        #expect(g.now.map(\.title) == ["T 3", "T 4", "T 1", "T 2"])
        #expect(g.now[0].owner == "You"); #expect(g.now[0].state == .needsYou)
        #expect(g.now[1].owner == "Bea")
        #expect(g.now.allSatisfy { $0.threadId != nil })
    }

    @Test func aPondThreadThatIsAlsoALocalChatOpensLocallyAndIsNotListedTwice() {
        let local = [PondThreadFact(key: Self.key("s3"), title: "T 3", state: .blocked, lastActivityAt: Self.ago(5))]
        let g = PondGlance.build(detail: Self.detail(), local: local, youName: "Sib", now: Self.now)
        #expect(g.now.filter { $0.title == "T 3" }.count == 1)
        #expect(g.now[0].localKey == Self.key("s3"))
    }

    @Test func recentIsNewestFirstAndCappedAtSix() {
        let g = PondGlance.build(detail: Self.detail(), local: [], youName: "Sib", now: Self.now)
        #expect(g.recent.count == PondGlance.recentCap)
        #expect(g.recent.map(\.at) == g.recent.map(\.at).sorted(by: >))
    }

    @Test func aPondOnlyOnThisMacReadsFromItsLocalChats() {
        let local = [
            PondThreadFact(key: Self.key("x"), title: "Fix login", state: .working, lastActivityAt: Self.ago(10), startedAt: Self.ago(600)),
            PondThreadFact(key: Self.key("y"), title: "Docs", state: .finished, lastActivityAt: Self.ago(900)),
            PondThreadFact(key: Self.key("z"), title: "Retry loop", state: .working, lastActivityAt: Self.ago(40), looping: true),
        ]
        let g = PondGlance.build(detail: nil, local: local, youName: "Sib Mac", now: Self.now)
        #expect(g.people.count == 1); #expect(g.people[0].line == "Working on Fix login")
        #expect(g.now.map(\.title) == ["Retry loop", "Fix login"])
        #expect(g.now[0].state == .needsYou)
        #expect(g.recent.contains { $0.sentence == "Docs finished" })
        #expect(PondGlance.build(detail: nil, local: [], youName: "", now: Self.now).now.isEmpty)
    }
}

@Suite struct ThreadGlanceTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func peopleAreOwnerThenTookPartThenWatchingWithTyping() {
        var t = PondThread(id: "t", title: "T", starter: "me", starterName: "Sib", state: "working", isPrivate: false)
        t.participants = [PondParticipant(memberId: "a", name: "Aarav", lastAt: Self.now)]
        let members = [FlockMember(id: "me", name: "Sib", you: true), FlockMember(id: "a", name: "Aarav"), FlockMember(id: "b", name: "Bea")]
        let presence = [PondPresenceEntry(member: "b", viewing: "t"), PondPresenceEntry(member: "a", viewing: "t", typingIn: "t"), PondPresenceEntry(member: "z", online: false, viewing: "t")]
        let g = ThreadGlance.build(agentName: "Claude", model: "Opus", state: .working, you: "Sib", thread: t, members: members, presence: presence, meId: "me")
        #expect(g.people.map(\.name) == ["Sib", "Aarav", "Bea"])
        #expect(g.people.map(\.line) == ["Owner", "Took part, typing", "Watching"])
        #expect(g.people[0].you)
        #expect(g.agentLine == "Claude \u{00B7} Opus")
        #expect(g.statusWord == "Working")
    }

    @Test func aThreadNoPondHoldsIsJustYou() {
        let g = ThreadGlance.build(agentName: nil, model: nil, state: .idle, you: "", thread: nil)
        #expect(g.people.count == 1); #expect(g.people[0].name == "You"); #expect(g.agentLine == nil)
    }

    @Test func runningHelpersQueueAndChangedFiles() {
        let helpers = [Duckling(id: "1", title: "Lint", status: .done), Duckling(id: "2", kind: .shell, title: "dev server", status: .running)]
        let files = (1...8).map { DaemonChanges.File(path: "src/f\($0).swift", added: 2, removed: 1) }
        let g = ThreadGlance.build(agentName: "Codex", model: nil, state: .working, you: "S", thread: nil,
                                   helpers: helpers, queued: ["a", "b", "c", "d"], files: files)
        #expect(g.helpers.first?.title == "dev server"); #expect(g.runningHelpers == 1)
        #expect(g.helpers.first?.isShell == true)
        #expect(g.queued == ["a", "b", "c"]); #expect(g.hasRunning)
        #expect(g.changed.count == ThreadGlance.changedCap); #expect(g.changedMore == 2)
        #expect(g.changedSummary == "Changed 8 files, +16 \u{2212}8")
        #expect(g.changed[0].name == "f1.swift")
        let idle = ThreadGlance.build(agentName: nil, model: nil, state: .idle, you: "S", thread: nil)
        #expect(!idle.hasRunning); #expect(idle.changed.isEmpty); #expect(idle.changedSummary == nil)
    }
}
