import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct QuietLoaderAndRulesTests {
    private func session(_ extra: String) throws -> DaemonSession {
        try JSONDecoder().decode(DaemonSession.self, from: Data(#"{"key":"k","state":"working","origin":"conductor"\#(extra)}"#.utf8))
    }

    @Test func conductorWaitingIsOptionalAndReachesTheMark() throws {
        let plain = try session("")
        #expect(plain.conductorWaiting == nil)
        let waiting = try session(#","conductorWaiting":true"#)
        #expect(waiting.conductorWaiting == true)
        let mapped = DaemonAdapter.map(waiting)
        #expect(mapped.backgroundWaiting == true)
        #expect(ChatMark.of(mapped, unread: false)?.quiet == true)
        #expect(ChatMark.of(DaemonAdapter.map(plain), unread: false)?.quiet == false)
    }

    @Test func ruleWordingFollowsTheHost() throws {
        func rule(_ kind: String, _ value: String) throws -> NativeRule {
            try JSONDecoder().decode(NativeRule.self, from: Data(#"{"id":"r","kind":"\#(kind)","value":"\#(value)"}"#.utf8))
        }
        #expect(try rule("tool", "Edit").text == "Edit (any use)")
        #expect(try rule("bash-exact", "npm test").text == "npm test")
        #expect(try rule("bash-prefix", "git status").text == "git status …")
    }
}
