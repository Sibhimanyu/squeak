import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct FolderPondTests {
    private func project(_ kind: String?) -> NativeProject {
        let k = kind.map { #","kind":"\#($0)""# } ?? ""
        let json = #"{"id":"p","name":"notes","rootPath":"/x/notes","defaultBranch":"main"\#(k)}"#
        return try! JSONDecoder().decode(NativeProject.self, from: Data(json.utf8))
    }

    @Test func aProjectIsAGitPondUnlessTheHostSaysFolder() {
        #expect(!project(nil).isPlainFolder)
        #expect(!project("git").isPlainFolder)
        #expect(project("folder").isPlainFolder)
        #expect(!project("bogus").isPlainFolder)
    }

    @Test func gitControlsAreDrawnOnlyForARepository() {
        #expect(FolderPond.showsGitControls(project("git")))
        #expect(FolderPond.showsGitControls(nil))
        #expect(!FolderPond.showsGitControls(project("folder")))
    }

    @Test func aStatusForAPlainFolderCarriesItsSentence() throws {
        let json = #"{"branch":null,"base":"","baseRef":null,"ahead":null,"behind":null,"dirty":0,"noHistory":"No version history."}"#
        let status = try JSONDecoder().decode(NativeGitStatus.self, from: Data(json.utf8))
        #expect(status.noHistory == "No version history.")
        #expect(try JSONDecoder().decode(NativeGitStatus.self, from: Data(#"{"base":"main","dirty":1}"#.utf8)).noHistory == nil)
    }

    @Test func aFolderPondStartsItsThreadInTheFolderWithNoPicker() {
        let pond = PondSummary(id: "p", name: "notes", projectId: "proj", canStartHere: true)
        guard case .open(let page, let c) = PondThreadEntry.resolve(pond: pond, workspaces: [], projectKind: "folder") else { Issue.record("x"); return }
        #expect(page == .thread(projectId: "proj", workspaceId: nil) && c.choice == .new && !c.showsPicker)
        // A repository with no stream yet still offers the picker (its first stream is new).
        guard case .open(_, let g) = PondThreadEntry.resolve(pond: pond, workspaces: [], projectKind: "git") else { Issue.record("x"); return }
        #expect(g.showsPicker)
    }

    @Test func theConfirmCountsFilesAndSize() {
        #expect(FolderPond.sizeWords(files: 1, bytes: 512) == "1 file, 512 bytes")
        #expect(FolderPond.sizeWords(files: 1204, bytes: 38 * 1024 * 1024).hasSuffix("files, 38 MB"))
        #expect(FolderPond.byteWords(3 * 1024 * 1024 * 1024) == "3.0 GB")
        guard case .commit(let q) = FolderPond.offer(NativeHistoryPreview(files: 3, bytes: 2048)) else { Issue.record("x"); return }
        #expect(q.contains("3 files, 2 KB") && q.contains(".gitignore"))
        guard case .commit(let kept) = FolderPond.offer(NativeHistoryPreview(files: 3, bytes: 2048, hasGitignore: true)) else { Issue.record("x"); return }
        #expect(!kept.contains(".gitignore"))
    }

    @Test func overALimitOnlyTheNoSnapshotRouteIsOffered() {
        let big = NativeHistoryPreview(files: 30_000, bytes: 10, tooBig: true, reason: "Too many files.")
        #expect(FolderPond.offer(big) == .withoutCommit(reason: "Too many files."))
    }

    @Test func theAtFilePickerWalksAFolderWithNoGit() throws {
        let fm = FileManager.default
        let dir = NSTemporaryDirectory() + "squeak-walk-\(UUID().uuidString)"
        try fm.createDirectory(atPath: dir + "/sub/deeper", withIntermediateDirectories: true)
        try fm.createDirectory(atPath: dir + "/node_modules/pkg", withIntermediateDirectories: true)
        try fm.createDirectory(atPath: dir + "/.hidden", withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: dir) }
        for f in ["a.txt", "sub/b.md", "sub/deeper/c.txt", "node_modules/pkg/x.js", ".hidden/y.txt", ".secret"] {
            try "1".write(toFile: dir + "/" + f, atomically: true, encoding: .utf8)
        }
        #expect(WorkspaceFileIndex.walk(in: dir) == ["a.txt", "sub/b.md", "sub/deeper/c.txt"])
        #expect(WorkspaceFileIndex.walk(in: dir, cap: 2).count == 2)
        // The index itself falls back to the walk when the folder is not a repository.
        #expect(Set(WorkspaceFileIndex.gitList(in: dir)) == ["a.txt", "sub/b.md", "sub/deeper/c.txt"])
        #expect(WorkspaceFileIndex.walk(in: dir + "/missing").isEmpty)
    }
}
