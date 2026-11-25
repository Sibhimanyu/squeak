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
}
