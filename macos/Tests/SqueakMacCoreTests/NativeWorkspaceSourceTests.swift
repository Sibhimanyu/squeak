import Testing
@testable import SqueakMacCore

struct NativeWorkspaceSourceTests {
    @Test func readsNumbersLinksAndBranchNames() {
        #expect(NativeWorkspaceSource.parse("#12", as: "pr") == .pullRequest(12))
        #expect(NativeWorkspaceSource.parse("https://github.com/o/r/pull/34", as: "pr") == .pullRequest(34))
        #expect(NativeWorkspaceSource.parse(" 7 ", as: "issue") == .issue(7))
        #expect(NativeWorkspaceSource.parse("https://github.com/o/r/issues/9", as: "issue") == .issue(9))
        #expect(NativeWorkspaceSource.parse("feature/x", as: "branch") == .branch("feature/x"))
        #expect(NativeWorkspaceSource.parse("release/2", as: "base") == .base("release/2"))
        #expect(NativeWorkspaceSource.parse("not a number", as: "pr") == nil)
        #expect(NativeWorkspaceSource.parse("0", as: "issue") == nil)
        #expect(NativeWorkspaceSource.parse("two words", as: "branch") == nil)
        #expect(NativeWorkspaceSource.parse("", as: "branch") == nil)
    }

    @Test func sendsTheHostsShape() {
        #expect(NativeWorkspaceSource.pullRequest(3).json == .object(["kind": .string("pr"), "number": .number(3)]))
        #expect(NativeWorkspaceSource.base("dev").json == .object(["kind": .string("base"), "branch": .string("dev")]))
    }
}
