import Foundation
import SqueakMacCore
import Testing

@Suite struct PondLiveTabsTests {
    private let diff = TabItem.diff(session: "chat-a", path: "A.swift")
    private let file = TabItem.pondFile(root: "/r", path: "B.swift")
    private let art = TabItem.artifact(pond: "p", path: "/x/Poster.html")

    @Test func firstReadingIsABaselineNotAnUpdate() {
        var live = PondLiveTabs()
        live.observe(diff, .present(stamp: "M/1/0"), viewing: false)
        #expect(!live.isUpdated(diff))
    }

    @Test func changeMarksAPillYouAreNotOnUntilYouVisit() {
        var live = PondLiveTabs()
        live.observe(file, .present(stamp: "1"), viewing: false)
        live.observe(file, .present(stamp: "2"), viewing: false)
        #expect(live.isUpdated(file))
        live.observe(file, .present(stamp: "2"), viewing: false)
        #expect(live.isUpdated(file))
        live.visit(file)
        #expect(!live.isUpdated(file))
    }

    @Test func changeOnTheTabYouAreViewingIsNotMarked() {
        var live = PondLiveTabs()
        live.observe(file, .present(stamp: "1"), viewing: true)
        live.observe(file, .present(stamp: "2"), viewing: true)
        #expect(!live.isUpdated(file))
        live.observe(file, .present(stamp: "3"), viewing: false)
        #expect(live.isUpdated(file))
        live.observe(file, .present(stamp: "3"), viewing: true)
        #expect(!live.isUpdated(file))
    }

    @Test func goneNeedsTwoReadingsAndNeverMarksUpdated() {
        var live = PondLiveTabs()
        live.observe(file, .present(stamp: "1"), viewing: false)
        live.observe(file, .gone(.fileRemoved), viewing: false)
        #expect(live.goneState(file) == nil)
        live.observe(file, .present(stamp: "1"), viewing: false)  // saved: back
        live.observe(file, .gone(.fileRemoved), viewing: false)
        #expect(live.goneState(file) == nil)
        live.observe(file, .gone(.fileRemoved), viewing: false)
        #expect(live.goneState(file) == .fileRemoved)
        #expect(!live.isUpdated(file))
    }

    @Test func unknownReadingChangesNothing() {
        var live = PondLiveTabs()
        live.observe(art, .gone(.artifactDeleted), viewing: false)
        live.observe(art, .unknown, viewing: false)
        live.observe(art, .gone(.artifactDeleted), viewing: false)
        #expect(live.goneState(art) == .artifactDeleted)
    }

    @Test func aSourceThatReturnsClearsItsGoneState() {
        var live = PondLiveTabs()
        for _ in 0..<2 { live.observe(art, .gone(.artifactDeleted), viewing: false) }
        live.observe(art, .present(stamp: "9"), viewing: false)
        #expect(live.goneState(art) == nil)
    }

    @Test func retainForgetsClosedTabs() {
        var live = PondLiveTabs()
        live.observe(file, .present(stamp: "1"), viewing: false)
        live.observe(file, .present(stamp: "2"), viewing: false)
        live.retain([diff])
        #expect(!live.isUpdated(file))
    }

    @Test func diffSources() {
        let a = DaemonChanges.File(path: "A.swift", status: "M", added: 2, removed: 1)
        let b = DaemonChanges.File(path: "B.swift")
        #expect(PondTabSources.diff(duckExists: false, merged: false, changes: [a], path: "A.swift") == .gone(.duckDeleted))
        #expect(PondTabSources.diff(duckExists: true, merged: true, changes: [], path: "A.swift") == .gone(.merged))
        #expect(PondTabSources.diff(duckExists: true, merged: false, changes: nil, path: "A.swift") == .unknown)
        #expect(PondTabSources.diff(duckExists: true, merged: false, changes: [b], path: "A.swift") == .gone(.noDiff))
        #expect(PondTabSources.diff(duckExists: true, merged: false, changes: [a, b], path: "A.swift") == .present(stamp: "M/2/1"))
        let before = PondTabSources.diff(duckExists: true, merged: false, changes: [a], path: nil)
        let after = PondTabSources.diff(duckExists: true, merged: false, changes: [a, b], path: nil)
        #expect(before != after)
        #expect(PondTabSources.diff(duckExists: true, merged: false, changes: [], path: nil) != .gone(.noDiff))
    }

    @Test func fileAndArtifactSources() {
        #expect(PondTabSources.file(checked: false, stamp: nil) == .unknown)
        #expect(PondTabSources.file(checked: true, stamp: nil) == .gone(.fileRemoved))
        #expect(PondTabSources.file(checked: true, stamp: FileStamp(modified: 1, size: 2))
            != PondTabSources.file(checked: true, stamp: FileStamp(modified: 3, size: 2)))
        let item = ArtifactItem(path: "/x/Poster.html", modifiedAt: Date(timeIntervalSince1970: 5), size: 3)
        #expect(PondTabSources.artifact(loaded: false, failed: false, listed: nil) == .unknown)
        #expect(PondTabSources.artifact(loaded: true, failed: true, listed: nil) == .unknown)
        #expect(PondTabSources.artifact(loaded: true, failed: false, listed: nil) == .gone(.artifactDeleted))
        if case .present = PondTabSources.artifact(loaded: true, failed: false, listed: item) {} else { Issue.record("present expected") }
    }

    @Test func goneTitlesAreTheSpecsWords() {
        #expect(PondTabGone.merged.title == "Merged")
        #expect(PondTabGone.duckDeleted.title == "Duck deleted")
        #expect(PondTabGone.fileRemoved.title == "File removed")
    }
}
