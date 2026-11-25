import SqueakMacCore
import Testing

@Suite struct DiffTabHeaderTests {
    @Test func fileTabNamesTheFileAndAsksTheDuck() {
        let h = DiffTabHeader(duck: "Pip", branch: "pip/fix", path: "Sources/A.swift")
        #expect(h.title == "A.swift")
        #expect(h.askLabel == "Ask Pip to fix…")
        #expect(h.askMessage("  rename it ") == "About Sources/A.swift:\nrename it")
        #expect(h.askMessage("   ") == nil)
    }

    @Test func reviewAllAsksAboutAllChanges() {
        let h = DiffTabHeader(duck: " ", branch: "", path: nil, fileCount: 3)
        #expect(h.duck == "the Duck")
        #expect(h.branch == nil)
        #expect(h.askMessage("tighten") == "tighten")
        #expect(h.askPlaceholder.contains("changes"))
    }

    @Test func mergeControlsOnlyForADucksOwnBranch() {
        #expect(ReviewAllControls.shows(isSqueakChat: true, canSeeCode: true, isMain: false, hasHistory: true))
        #expect(!ReviewAllControls.shows(isSqueakChat: true, canSeeCode: true, isMain: true, hasHistory: true))
        #expect(!ReviewAllControls.shows(isSqueakChat: true, canSeeCode: false, isMain: false, hasHistory: true))
        #expect(!ReviewAllControls.shows(isSqueakChat: false, canSeeCode: true, isMain: false, hasHistory: true))
        #expect(!ReviewAllControls.shows(isSqueakChat: true, canSeeCode: true, isMain: false, hasHistory: false))
    }

    @Test func oneFoldToggleFoldsWhileAnyFileIsOpenThenUnfolds() {
        let paths = ["a", "b", "c"]
        // Some open: the toggle folds, and flips only the open ones.
        var folded: Set<String> = ["a"]
        #expect(!ReviewAllControls_isUnfolding(paths, folded))
        #expect(ReviewFoldAll.title(unfolding: false) == "Fold all")
        #expect(ReviewFoldAll.toToggle(paths: paths, isFolded: { folded.contains($0) }) == ["b", "c"])
        // All folded: it unfolds every file.
        folded = ["a", "b", "c"]
        #expect(ReviewAllControls_isUnfolding(paths, folded))
        #expect(ReviewFoldAll.title(unfolding: true) == "Unfold all")
        #expect(ReviewFoldAll.toToggle(paths: paths, isFolded: { folded.contains($0) }) == paths)
        // No files: nothing to unfold, nothing to toggle.
        #expect(!ReviewFoldAll.isUnfolding(paths: [], isFolded: { _ in true }))
        #expect(ReviewFoldAll.toToggle(paths: [], isFolded: { _ in true }).isEmpty)
    }

    private func ReviewAllControls_isUnfolding(_ paths: [String], _ folded: Set<String>) -> Bool {
        ReviewFoldAll.isUnfolding(paths: paths, isFolded: { folded.contains($0) })
    }

    @Test func shareDuckChatNeedsADuckASharedPondAndAChatNotYetShared() {
        #expect(ShareDuckRule.offered(sharedPond: true, canMessage: true, hostId: "h1", sharedSessionIds: ["h2"]))
        #expect(!ShareDuckRule.offered(sharedPond: true, canMessage: true, hostId: "h1", sharedSessionIds: ["h1"]))
        #expect(!ShareDuckRule.offered(sharedPond: true, canMessage: true, hostId: nil, sharedSessionIds: []))
        #expect(!ShareDuckRule.offered(sharedPond: false, canMessage: true, hostId: "h1", sharedSessionIds: []))
        #expect(!ShareDuckRule.offered(sharedPond: true, canMessage: false, hostId: "h1", sharedSessionIds: []))
    }
}
