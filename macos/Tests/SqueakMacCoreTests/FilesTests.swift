import Foundation
import Testing

@testable import SqueakMacCore

@Suite("File tree")
struct FileTreeTests {
    private func e(_ p: String, dir: Bool = false) -> FileEntry { FileEntry(path: p, isDirectory: dir) }

    @Test func foldersFirstThenNamesIgnoringCase() {
        let list = FileTree.order([e("b.txt"), e("Zed", dir: true), e("A.txt"), e("alpha", dir: true)])
        #expect(list.map(\.name) == ["alpha", "Zed", "A.txt", "b.txt"])
    }

    @Test func gitIsNeverListedAndIgnoredOnlyWithTheToggle() {
        let all = [e(".git", dir: true), e("src", dir: true), e("build", dir: true), e("a.ts")]
        let ignored: Set<String> = ["build"]
        #expect(FileTree.visible(all, ignored: ignored, showIgnored: false).map(\.name) == ["src", "a.ts"])
        #expect(FileTree.visible(all, ignored: ignored, showIgnored: true).map(\.name) == ["src", "build", "a.ts"])
    }

    @Test func rowsFollowExpansionAndDepth() {
        let children = [
            "": [e("src", dir: true), e("README.md")],
            "src": [e("src/lib", dir: true), e("src/main.ts")],
            "src/lib": [e("src/lib/x.ts")],
        ]
        let closed = FileTree.rows(children: children, expanded: [], ignored: [], showIgnored: false)
        #expect(closed.map(\.entry.path) == ["src", "README.md"])
        let open = FileTree.rows(children: children, expanded: ["src", "src/lib"], ignored: [], showIgnored: false)
        #expect(open.map(\.entry.path) == ["src", "src/lib", "src/lib/x.ts", "src/main.ts", "README.md"])
        #expect(open.map(\.depth) == [0, 1, 2, 1, 0])
        // Expanded but not read yet: no children, no crash.
        #expect(FileTree.rows(children: ["": children[""]!], expanded: ["src"], ignored: [], showIgnored: false).count == 2)
    }

    @Test func ancestorsAndParent() {
        #expect(FileTree.ancestors(of: "a/b/c.txt") == ["a", "a/b"])
        #expect(FileTree.ancestors(of: "c.txt").isEmpty)
        #expect(FileTree.parent(of: "a/b/c.txt") == "a/b")
        #expect(FileTree.parent(of: "c.txt") == "")
    }

    @Test func changeMarksNameFilesAndTheirFolders() {
        let marks = FileChangeMarks([.init(path: "src/lib/x.ts", status: "M"), .init(path: "new.md", status: "A")])
        #expect(marks.status(of: e("new.md")) == "A")
        #expect(marks.status(of: e("src/lib/x.ts")) == "M")
        #expect(marks.status(of: e("other.md")) == nil)
        #expect(marks.holdsChange(e("src", dir: true)) && marks.holdsChange(e("src/lib", dir: true)))
        #expect(!marks.holdsChange(e("docs", dir: true)))
        #expect(marks.status(of: e("src", dir: true)) == nil)
    }

    @Test func filterWantsEveryWordAndPutsNameMatchesFirst() {
        let paths = ["docs/guide-config.md", "src/config.ts", "src/other/deep/config-loader.ts", "src/app.ts"]
        #expect(FileFilter.match("config", in: paths) == ["src/config.ts", "src/other/deep/config-loader.ts", "docs/guide-config.md"])
        #expect(FileFilter.match("src loader", in: paths) == ["src/other/deep/config-loader.ts"])
        #expect(FileFilter.match("  ", in: paths).isEmpty)
        #expect(FileFilter.match("zzz", in: paths).isEmpty)
        #expect(FileFilter.match("ts", in: paths, limit: 2).count == 2)
    }
}

@Suite("File disk")
struct FileDiskTests {
    private func tempRoot() throws -> String {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d.path
    }

    @Test func classifyTextImageBinaryAndBig() {
        #expect(FileKind.classify(name: "a.swift", size: 100, head: Data("let x = 1".utf8)) == .text)
        #expect(FileKind.classify(name: "a.PNG", size: 5_000_000, head: Data([0x89, 0x50])) == .image)
        #expect(FileKind.classify(name: "huge.png", size: 30_000_000, head: Data()) == .external("It is over 25 MB"))
        #expect(FileKind.classify(name: "a.log", size: 2_097_153, head: Data("x".utf8)) == .external("It is over 2 MB"))
        #expect(FileKind.classify(name: "a.log", size: 2_097_152, head: Data("x".utf8)) == .text)
        #expect(FileKind.classify(name: "a.bin", size: 10, head: Data([0x41, 0x00, 0x42])) == .external("It is not a text file"))
        #expect(FileKind.classify(name: "a.dat", size: 10, head: Data([0xFF, 0xFE, 0xFD])) == .external("It is not a text file"))
        // A multi-byte character cut by the 8 KB window is still text.
        let cut = Data("héllo".utf8).dropLast()
        #expect(FileKind.classify(name: "a.txt", size: 10, head: cut) == .text)
    }

    @Test func saveGuardNamesTheConflict() {
        let a = FileStamp(modified: 10, size: 5)
        #expect(SaveGuard.check(opened: a, current: a) == nil)
        #expect(SaveGuard.check(opened: a, current: FileStamp(modified: 11, size: 5)) == .changedOnDisk)
        #expect(SaveGuard.check(opened: a, current: FileStamp(modified: 10, size: 6)) == .changedOnDisk)
        #expect(SaveGuard.check(opened: a, current: nil) == .deletedOnDisk)
    }

    @Test func resolveStaysInsideTheRoot() throws {
        let root = try tempRoot()
        #expect(FileDisk.resolve(root: root, relative: "a/b.txt") != nil)
        #expect(FileDisk.resolve(root: root, relative: "../x") == nil)
        #expect(FileDisk.resolve(root: root, relative: "a/../../x") == nil)
        #expect(FileDisk.resolve(root: root, relative: "/etc/passwd") == nil)
        try FileManager.default.createSymbolicLink(atPath: root + "/out", withDestinationPath: "/etc")
        #expect(FileDisk.resolve(root: root, relative: "out/hosts") == nil)
    }

    @Test func loadSaveAndRefuseAfterAnExternalEdit() throws {
        let root = try tempRoot()
        let path = root + "/note.txt"
        try "one\n".write(toFile: path, atomically: true, encoding: .utf8)
        guard case .text(let text, let stamp) = FileDisk.load(root: root, relative: "note.txt") else { Issue.record("not text"); return }
        #expect(text == "one\n")

        // Saving over the unchanged file works and gives the new stamp.
        guard case .saved(let after) = FileDisk.save(root: root, relative: "note.txt", text: "two\n", opened: stamp) else {
            Issue.record("not saved"); return
        }
        #expect(try String(contentsOfFile: path, encoding: .utf8) == "two\n")

        // Someone else edits it: the next save with the old stamp is refused, nothing is written.
        try "theirs, longer\n".write(toFile: path, atomically: true, encoding: .utf8)
        #expect(FileDisk.save(root: root, relative: "note.txt", text: "mine\n", opened: after) == .conflict(.changedOnDisk))
        #expect(try String(contentsOfFile: path, encoding: .utf8) == "theirs, longer\n")
        // Overwrite is a deliberate second step.
        if case .saved = FileDisk.save(root: root, relative: "note.txt", text: "mine\n", opened: after, overwrite: true) {} else { Issue.record("no overwrite") }

        try FileManager.default.removeItem(atPath: path)
        #expect(FileDisk.save(root: root, relative: "note.txt", text: "x", opened: after) == .conflict(.deletedOnDisk))
    }

    @Test func saveKeepsPermissions() throws {
        let root = try tempRoot()
        let path = root + "/run.sh"
        try "echo\n".write(toFile: path, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path)
        let stamp = try #require(FileDisk.stamp(URL(fileURLWithPath: path)))
        _ = FileDisk.save(root: root, relative: "run.sh", text: "echo hi\n", opened: stamp)
        let perms = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
        #expect(perms?.intValue == 0o755)
    }

    @Test func largeAndBinaryFilesOpenExternally() throws {
        let root = try tempRoot()
        try Data([0, 1, 2, 3]).write(to: URL(fileURLWithPath: root + "/a.bin"))
        #expect(FileDisk.load(root: root, relative: "a.bin") == .external("It is not a text file"))
        try Data(repeating: 0x61, count: FileKind.maxTextBytes + 1).write(to: URL(fileURLWithPath: root + "/big.txt"))
        #expect(FileDisk.load(root: root, relative: "big.txt") == .external("It is over 2 MB"))
        if case .failed = FileDisk.load(root: root, relative: "missing.txt") {} else { Issue.record("expected failure") }
    }

    @Test func listingAndGitIgnore() throws {
        let root = try tempRoot()
        let fm = FileManager.default
        try fm.createDirectory(atPath: root + "/src", withIntermediateDirectories: true)
        try fm.createDirectory(atPath: root + "/dist", withIntermediateDirectories: true)
        try "x".write(toFile: root + "/src/a.ts", atomically: true, encoding: .utf8)
        try "dist/\n".write(toFile: root + "/.gitignore", atomically: true, encoding: .utf8)
        // Not a repository yet: nothing is ignored.
        #expect(FileDisk.gitIgnored(root: root, paths: ["dist"]).isEmpty)
        let entries = FileDisk.list(root: root, relative: "")
        #expect(entries.first { $0.path == "src" }?.isDirectory == true)
        #expect(FileDisk.list(root: root, relative: "src").map(\.path) == ["src/a.ts"])
        #expect(FileDisk.list(root: root, relative: "../").isEmpty)

        _ = FileDisk.runGit(["init", "-q"], in: root, input: nil)
        #expect(FileDisk.gitIgnored(root: root, paths: ["dist", "src", "src/a.ts"]) == ["dist"])
        #expect(FileDisk.allFiles(root: root).sorted() == [".gitignore", "src/a.ts"])
    }
}

@Suite("Diff comments")
struct DiffCommentTests {
    private let lines = DiffParser.lines("""
        diff --git a/f.ts b/f.ts
        --- a/f.ts
        +++ b/f.ts
        @@ -10,4 +10,5 @@
         keep
        -old one
        -old two
        +new one
        +new two
        +new three
         tail
        """)

    @Test func oneLineLabelIsItsNewNumber() throws {
        let c = try #require(DiffComments.make(path: "f.ts", lines: [lines[4]], text: "  why?  "))
        #expect(c.label == "11" && c.quoted == ["new one"] && c.text == "why?")
    }

    @Test func rangeUsesNewNumbersAndSkipsHunkHeaders() throws {
        // Lines 0 = hunk header, 1 keep(10), 2-3 removed, 4-6 added (11-13), 7 tail(14).
        let c = try #require(DiffComments.make(path: "f.ts", lines: Array(lines[0...7]), text: "tidy"))
        #expect(c.label == "10-14")
        #expect(c.quoted.first == "keep" && c.quoted.count == 7)
    }

    @Test func removedOnlySelectionNamesTheOldLines() throws {
        let c = try #require(DiffComments.make(path: "f.ts", lines: [lines[2], lines[3]], text: "restore"))
        #expect(c.label == "11-12 (removed)")
        #expect(DiffComments.anchorIndex(of: c, in: lines) == 3)
    }

    @Test func nothingToCommentOnOrNoWordsMakesNoComment() {
        #expect(DiffComments.make(path: "f.ts", lines: [lines[0]], text: "x") == nil)
        #expect(DiffComments.make(path: "f.ts", lines: [lines[4]], text: "   \n") == nil)
    }

    @Test func rangeIsOrderedEitherWay() {
        #expect(DiffComments.range(anchor: 5, to: 2) == 2...5)
        #expect(DiffComments.range(anchor: 2, to: 5) == 2...5)
    }

    @Test func anchorFindsTheLastLineOfAnAddedRange() throws {
        let c = try #require(DiffComments.make(path: "f.ts", lines: [lines[4], lines[5]], text: "x"))
        #expect(DiffComments.anchorIndex(of: c, in: lines) == 5)
        #expect(DiffComments.anchorIndex(of: c, in: Array(lines[0...3])) == nil)
    }

    @Test func messageListsPathLineQuoteAndComment() throws {
        var tray = DiffCommentTray()
        #expect(tray.message.isEmpty)
        tray.add(try #require(DiffComments.make(path: "f.ts", lines: [lines[4]], text: "Why a second copy?")))
        #expect(tray.message == "Review comment on your changes:\n\nf.ts:11\n> new one\nWhy a second copy?")
        tray.add(try #require(DiffComments.make(path: "g.ts", lines: [lines[2]], text: "Keep it.\nPlease.")))
        #expect(tray.message == """
            Review comments on your changes:

            f.ts:11
            > new one
            Why a second copy?

            g.ts:11 (removed)
            > old one
            Keep it.
            Please.
            """)
        #expect(tray.comments(in: "g.ts").count == 1)
        tray.remove(tray.comments[0].id)
        #expect(tray.count == 1)
        tray.clear()
        #expect(tray.isEmpty)
    }

    @Test func longQuotesAreClipped() throws {
        let many = (1...12).map { DiffLine(kind: .added, newNumber: $0, text: String(repeating: "x", count: 250)) }
        let msg = DiffComments.message([try #require(DiffComments.make(path: "p", lines: many, text: "big"))])
        #expect(msg.contains("p:1-12"))
        #expect(msg.contains("> " + String(repeating: "x", count: 200) + "…"))
        #expect(msg.contains("> … 4 more lines"))
        #expect(!msg.contains(String(repeating: "x", count: 201)))
    }
}

@Suite struct HostCommentTests {
    private let lines = DiffParser.lines("@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d\n")

    @Test func hostCommentSitsUnderItsNewFileLine() {
        let c = NativeComment(id: "1", file: "f.swift", line: 3, body: "x", author: "agent:s")
        #expect(c.isAgent)
        let i = DiffComments.anchorIndex(ofHost: c, in: lines)
        #expect(i.map { lines[$0].newNumber } == 3)
        #expect(DiffComments.anchorIndex(ofHost: NativeComment(id: "2", file: "f", line: 99, body: "", author: "user"), in: lines) == nil)
    }

    @Test func onlyNewFileLinesGoToTheHost() {
        let added = DiffComments.make(path: "f", lines: [lines.last!], text: "hm")!
        #expect(DiffComments.hostLine(of: added) == lines.last!.newNumber)
        let removed = lines.first { $0.kind == .removed }!
        #expect(DiffComments.hostLine(of: DiffComments.make(path: "f", lines: [removed], text: "hm")!) == nil)
    }
}
