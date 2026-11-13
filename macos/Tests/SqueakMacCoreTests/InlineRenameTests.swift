import Testing
@testable import SqueakMacCore

@Suite struct InlineRenameTests {
    @Test func startsOnlyWhenRenamable() {
        var r = InlineRename<String>()
        r.start("a", canRename: false)
        #expect(r.editing == nil)
        r.start("a", canRename: true)
        #expect(r.isEditing("a"))
        r.start("b", canRename: true)
        #expect(!r.isEditing("a") && r.isEditing("b"))
    }

    @Test func invalidKeepsEditingWithWords() {
        var r = InlineRename<String>()
        r.start("a", canRename: true)
        #expect(r.commit("  ", current: "Old") == .invalid(ThreadTitle.Problem.empty.words))
        #expect(r.isEditing("a") && r.problem == ThreadTitle.Problem.empty.words)
        r.edited()
        #expect(r.problem == nil)
        #expect(r.commit(String(repeating: "x", count: 201), current: "Old") == .invalid(ThreadTitle.Problem.tooLong.words))
    }

    @Test func unchangedAndSaveEndEditing() {
        var r = InlineRename<String>()
        r.start("a", canRename: true)
        #expect(r.commit(" Old ", current: "Old") == .unchanged)
        #expect(r.editing == nil)
        r.start("a", canRename: true)
        #expect(r.commit("a\nb", current: "Old") == .save("a b"))
        #expect(r.editing == nil)
    }

    @Test func cancelEnds() {
        var r = InlineRename<String>()
        r.start("a", canRename: true)
        _ = r.commit("", current: "x")
        r.cancel()
        #expect(r.editing == nil && r.problem == nil)
    }
}
