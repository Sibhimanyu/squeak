import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ContextAutoCompactLineTests {
    @Test func popoverStatesTheRealRule() {
        func line(_ at: Int??) -> String {
            ContextFormat.Popover.make(tokens: 132_100, limit: 1_000_000, percent: nil, canCompact: true, working: false, autoCompactAt: at).autoLine
        }
        #expect(line(.some(200_000)) == "Compacts automatically at 200k tokens")
        #expect(line(.some(nil)) == "Automatic compaction is off")
        #expect(line(nil) == "Compacts automatically near the limit")
    }

    @Test func largeNoticeSaysCompactingSoonOnlyWhenAutoCompactIsOn() {
        var s = HostSession(key: SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: "squeak-native:1"), state: .finished)
        s.largeChat = true
        #expect(NativeChatNotice.largeText(for: s) == NativeChatNotice.largeText)
        s.largeCompacting = true
        #expect(NativeChatNotice.largeText(for: s) == "Compacting soon to keep replies fast")
    }

    @Test func hostFlagsDecode() throws {
        let json = #"{"id":"a","status":"idle","large":{"reason":"context","transcriptBytes":null,"compacting":true},"autoCompactAt":200000}"#
        let s = try JSONDecoder().decode(NativeSession.self, from: Data(json.utf8))
        #expect(s.isLarge && s.largeCompacting)
        #expect(s.autoCompactAt == .some(200_000))
        let off = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"a","autoCompactAt":null}"#.utf8))
        #expect(off.autoCompactAt == .some(nil))
        let old = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"a"}"#.utf8))
        #expect(old.autoCompactAt == nil)
    }
}
