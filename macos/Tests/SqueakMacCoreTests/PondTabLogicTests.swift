import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondTabLogicTests {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    // Live shape: the host's duck roster says currentSessionId "e3e6f551-…", the app keys that chat "squeak-native:e3e6f551-…".
    private let hostId = "e3e6f551-3631-4db9-a147-c04791575972"
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + id) }
    private func chat(_ id: String, duck: String? = nil, state: SessionState = .idle, branch: String? = nil, ago: Double = 10) -> HostSession {
        var s = HostSession(key: key(id), title: id, branch: branch, state: state, lastActivityAt: t0.addingTimeInterval(-ago))
        s.duckId = duck
        return s
    }

    @Test func prefixedKeyMatchesThePondsHostSessionId() {
        #expect(PondOpenResolver.hostId(of: key(hostId)) == hostId)
        var t = PondThread(id: "1", title: "T", starter: "me", starterName: "Sib", state: "working", isPrivate: false, updatedAt: t0)
        t.sessionId = hostId
        let d = PondDetail(pond: PondSummary(id: "p", name: "Site"), members: [FlockMember(id: "me", name: "Sib", role: .owner, online: true, you: true)], threads: [t])
        let fact = PondThreadFact(key: key(hostId), title: "T", state: .working, lastActivityAt: t0)
        let g = PondGlance.build(detail: d, local: [fact], youName: "Sib", now: t0)
        #expect(g.now.count == 1)
        #expect(g.now[0].localKey == key(hostId))   // opens the chat tab, not the pond thread page
    }

    @Test func clickOnAnOlderChatOpensTheDucksCurrentChat() {
        let old = chat("old", duck: "D", ago: 500), cur = chat("cur", duck: "D", ago: 5)
        #expect(DuckOpen.target(old, ducksMode: true, pool: [old, cur]).key == cur.key)
        #expect(DuckOpen.target(old, ducksMode: false, pool: [old, cur]).key == old.key)
    }

    @Test func openIsWorkingOrNeedingYouWithBranchAndNeedsFirst() {
        let a = chat("a", duck: "A", state: .working, branch: "feat/a", ago: 5)
        let b = chat("b", duck: "B", state: .blocked, branch: "feat/b", ago: 50)
        let c = chat("c", duck: "C", state: .idle, ago: 1)
        let d = chat("d", duck: "D", state: .working, ago: 1)
        let rows = DuckList.rows([a, b, c, d], main: nil)
        let out = PondOpenDucks.rows(rows, title: { $0.title }, closed: { $0.key == d.key })
        #expect(out.map(\.title) == ["b", "a"])
        #expect(out.map(\.branch) == ["feat/b", "feat/a"])
        #expect(PondOpenDucks.rows(rows, title: { $0.title }, showsBranch: false).allSatisfy { $0.branch == nil })
        #expect(PondOpenDucks.rows([], title: { $0.title }).isEmpty)
    }

    @Test func recentKeepsOnlyActionableEvents() {
        func r(_ kind: PondRipple.Kind, _ s: String) -> PondRipple { PondRipple(id: s, kind: kind, sentence: s, at: t0, threadKey: nil) }
        let all = [r(.remote, "You withdrew an invite"), r(.remote, "Sib made the pond"), r(.remote, "Sib archived a private thread"),
                   r(.remote, "Aarav joined"), r(.finished, "Fix login finished"), r(.needsYou, "Fix login needs you"),
                   r(.started, "Fix login started"), r(.remote, "Aarav asked you a question")]
        #expect(PondRecent.actionable(all).map(\.sentence) == ["Aarav joined", "Fix login finished", "Fix login needs you", "Aarav asked you a question"])
    }

    @Test func recentUsesTheHostsKindWhenPresentAndTheWordsWhenNot() throws {
        func r(_ text: String, _ kind: RippleWireKind?) -> PondRipple { PondRipple(id: text, kind: .remote, sentence: text, at: t0, threadKey: nil, wireKind: kind) }
        let all = [r("withdrew an invite", .invite), r("finished the task X", .finished), r("Aarav joined", .joined),
                   // The kind wins over the words: "joined" in a left line is not a joining.
                   r("left; Sam joined the call", .left), r("Aarav asked you a question", nil), r("made the pond", .created)]
        #expect(PondRecent.actionable(all).map(\.sentence) == ["finished the task X", "Aarav joined", "Aarav asked you a question"])
    }

    @Test func aRippleKindDecodesAndAnOldOrUnknownOneIsNil() throws {
        let json = #"[{"id":"a","at":1,"text":"joined","kind":"needs_you"},{"id":"b","at":1,"text":"x"},{"id":"c","at":1,"text":"y","kind":"from-the-future"}]"#
        let rows = try JSONDecoder().decode([RippleEntry].self, from: Data(json.utf8))
        #expect(rows.map(\.kind) == [.needsYou, nil, nil])
        #expect(PondRippleFeed.build(rows).first { $0.id == "pond:a" }?.wireKind == .needsYou)
    }
}
