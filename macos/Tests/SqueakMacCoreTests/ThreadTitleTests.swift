import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct ThreadTitleTests {
    @Test func checks() {
        #expect(ThreadTitle.check("  Fix the build  ") == .success("Fix the build"))
        #expect(ThreadTitle.check("") == .failure(.empty))
        #expect(ThreadTitle.check(" \n ") == .failure(.empty))
        #expect(ThreadTitle.check("a\nb") == .success("a b"))
        #expect(ThreadTitle.check(String(repeating: "x", count: 200)) == .success(String(repeating: "x", count: 200)))
        #expect(ThreadTitle.check(String(repeating: "x", count: 201)) == .failure(.tooLong))
    }

    @Test func onlySqueakChatsCanBeRenamed() {
        let native = HostSession(key: SessionKey(provider: "claude-squeak", hostSessionId: NativeAdapter.keyPrefix + "abc"))
        let conductor = HostSession(key: SessionKey(provider: "conductor", hostSessionId: "s1"))
        let terminal = HostSession(key: SessionKey(provider: "claude-terminal", hostSessionId: "t"))
        #expect(ThreadTitle.canRename(native))
        #expect(!ThreadTitle.canRename(conductor))
        #expect(!ThreadTitle.canRename(terminal))
    }
}
