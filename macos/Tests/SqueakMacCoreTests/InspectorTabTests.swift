import Testing
@testable import SqueakMacCore

@Suite struct InspectorTabTests {
    @Test func theUpperPartHasThreeTabsForEveryChat() {
        #expect(InspectorTab.available(native: true).map(\.title) == ["All files", "Changes", "Review"])
        #expect(InspectorTab.available(native: false).map(\.title) == ["All files", "Changes", "Review"])
    }

    @Test func aTabSavedByAnOlderBuildOpensChanges() {
        #expect(InspectorTab.restored("checks") == .changes)
        #expect(InspectorTab.restored("review") == .review)
    }

    @Test func theLowerPartHasWorkspaceTabsOnlyForSqueakChats() {
        #expect(InspectorLowerTab.available(native: true).map(\.title) == ["Setup", "Run", "Terminal"])
        #expect(InspectorLowerTab.available(native: false).map(\.title) == ["Terminal"])
        #expect(InspectorLowerTab.restored("run", native: false) == .terminal)
        #expect(InspectorLowerTab.restored("run", native: true) == .run)
        #expect(InspectorLowerTab.restored("nonsense", native: true) == .terminal)
    }

    @Test func changeRowsSplitFolderFromName() {
        #expect(ChangeListing.split("agent-plugin/skills/squeak/SKILL.md") == ("agent-plugin/skills/squeak/", "SKILL.md"))
        #expect(ChangeListing.split("CLAUDE.md") == ("", "CLAUDE.md"))
        #expect(ChangeListing.header(count: 850) == "850 files changed")
        #expect(ChangeListing.header(count: 1) == "1 file changed")
    }

    @Test func searchMatchesEveryWordInThePath() {
        let files = ["src/a/Foo.swift", "src/b/Bar.swift", "README.md"].map { DaemonChanges.File(path: $0) }
        #expect(ChangeListing.filter(files, query: "").count == 3)
        #expect(ChangeListing.filter(files, query: "SRC bar").map(\.path) == ["src/b/Bar.swift"])
        #expect(ChangeListing.filter(files, query: "nothing").isEmpty)
    }
}
