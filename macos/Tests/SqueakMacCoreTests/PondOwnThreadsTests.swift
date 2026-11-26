import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Own-Mac ducks, stashed")
struct PondOwnThreadsTests {
    private func shared() -> PondSummary { PondSummary(id: "p", name: "Site", role: .member, gitRemote: "git@x:a/b.git", canStartHere: true) }
    private func mine() -> PondSummary { PondSummary(id: "q", name: "Mine", role: .owner, gitRemote: "git@x:a/b.git", canStartHere: true) }

    @Test("an older host that says nothing keeps the mode; the daemon's word wins")
    func hostWord() throws {
        #expect(PondOwnThreads.enabled(nil))
        #expect(!PondOwnThreads.enabled(false))
        let off = try JSONDecoder().decode(PondDirectory.self, from: Data(#"{"schema":1,"ponds":[],"pondOwnThreads":false}"#.utf8))
        #expect(off.pondOwnThreads == false)
        let old = try JSONDecoder().decode(PondDirectory.self, from: Data(#"{"schema":1,"ponds":[]}"#.utf8))
        #expect(old.pondOwnThreads == nil)
    }

    @Test("off: a joined pond starts only on the owner's Mac; my own ponds are unchanged")
    func startsOnOwnerMac() {
        #expect(PondStartThread.offer(for: shared()) == .start)
        let off = PondOwnThreads.adjusted(shared(), ownThreads: false)
        #expect(PondStartThread.offer(for: off) != .start)
        #expect(PondStartThread.runsOnOwnerMac(off))
        #expect(PondOwnThreads.adjusted(mine(), ownThreads: false) == mine())
        #expect(PondOwnThreads.adjusted(shared(), ownThreads: true) == shared())
    }

    @Test("off: no 'on my Mac' place in a joined pond, and no Powered-by mark")
    func hidesTheOffer() {
        #expect(PondStartThread.places(for: shared()).contains { $0.kind == .own })
        #expect(!PondStartThread.places(for: shared(), ownThreads: false).contains { $0.kind == .own })
        #expect(PondStartThread.places(for: mine(), ownThreads: false).contains { $0.kind == .own })
        #expect(PondOwnThreads.poweredBy(nest: "Aarav-mac", ownThreads: false) == nil)
        #expect(PondOwnThreads.poweredBy(nest: "Aarav-mac", ownThreads: true) == "Powered by Aarav-mac \u{00B7} Flotilla")
    }
}
