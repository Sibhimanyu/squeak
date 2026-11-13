import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct DiskCleanupTests {
    private let gb: Int64 = 1_000_000_000

    private func items() -> [CleanupItem] {
        [
            CleanupItem(id: "a", kind: "untracked-folder", path: "/w/p/a", sizeBytes: 4 * gb),
            CleanupItem(id: "b", kind: "untracked-folder", path: "/w/p/b", sizeBytes: 2 * gb, unsavedWork: true, unsavedReason: "Uncommitted changes", preselected: false),
            CleanupItem(id: "c", kind: "archived-folder", path: "/w/p/c", sizeBytes: gb),
            CleanupItem(id: "d", kind: "stale-worktree", path: "/gone", sizeBytes: 0),
            CleanupItem(id: "e", kind: "merged-branch", branch: "u/x", sizeBytes: 0),
        ]
    }

    @Test func safeItemsAreSelectedAndUnsavedNever() {
        #expect(DiskCleanupLogic.initialSelection(items()) == ["a", "c", "d", "e"])
        // Even a host that preselected it cannot make the app tick an item with unsaved work.
        let risky = [CleanupItem(id: "x", kind: "untracked-folder", unsavedWork: true, preselected: true)]
        #expect(DiskCleanupLogic.initialSelection(risky).isEmpty)
    }

    @Test func groupsKeepOrderAndDropEmptyOnes() {
        let g = DiskCleanupLogic.groups(items())
        #expect(g.map(\.id) == ["untracked", "archived", "stale", "branches"])
        #expect(DiskCleanupLogic.groups(Array(items().prefix(1))).map(\.id) == ["untracked"])
    }

    @Test func confirmationSaysWhatWillHappen() {
        let all = Set(items().map(\.id))
        let text = DiskCleanupLogic.confirmation(items(), in: all)
        #expect(text.hasPrefix("Move 3 folders ("))
        #expect(text.contains("to the Trash and forget 1 stale worktree and delete 1 merged branch?"))
        #expect(DiskCleanupLogic.confirmation(items(), in: ["e"]) == "Delete 1 merged branch?")
        #expect(DiskCleanupLogic.confirmation(items(), in: []) == "Nothing selected.")
    }

    @Test func totalsAndResultLine() {
        #expect(DiskCleanupLogic.bytes(items(), in: ["a", "c"]) == 5 * gb)
        let line = DiskCleanupLogic.resultLine(CleanupResult(removedFolders: 11, removedBranches: 6, freedBytes: 44 * gb, failed: 1))
        #expect(line.hasPrefix("Moved 11 folders to the Trash, freeing "))
        #expect(line.contains("deleted 6 branches"))
        #expect(line.hasSuffix("1 item could not be removed."))
    }

    @Test func archiveOutcomeFromAnOlderHostIsNotDeletable() throws {
        let ws = #"{"id":"w","projectId":"p","name":"n","path":"/x","branch":"u/n","state":"archived","createdAt":"2026-01-01T00:00:00Z","title":"T"}"#
        let old = try JSONDecoder().decode(ArchiveOutcome.self, from: Data(#"{"workspace":\#(ws)}"#.utf8))
        #expect(old.branchDeletable == false)
        let new = try JSONDecoder().decode(ArchiveOutcome.self, from: Data(#"{"workspace":\#(ws),"branchDeletable":true,"branch":"u/n"}"#.utf8))
        #expect(new.branchDeletable && new.branch == "u/n")
    }
}
