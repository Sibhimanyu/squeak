import Foundation
import Testing

@testable import SqueakMacCore

@Suite("File operations")
struct FileOpsTests {
    private func sandbox() throws -> (root: String, outside: URL) {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-ops-\(UUID().uuidString)")
        let root = base.appendingPathComponent("ws"), outside = base.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        return (root.path, outside)
    }

    @Test func namesAreValidated() {
        #expect(FileNameRule.validate("", siblings: []) == "Give it a name.")
        #expect(FileNameRule.validate("   ", siblings: []) != nil)
        #expect(FileNameRule.validate("a/b", siblings: []) != nil)
        #expect(FileNameRule.validate("..", siblings: []) != nil)
        #expect(FileNameRule.validate(".", siblings: []) != nil)
        #expect(FileNameRule.validate(".GIT", siblings: []) != nil)
        #expect(FileNameRule.validate("a..b", siblings: []) == nil)
        #expect(FileNameRule.validate("Readme.md", siblings: ["readme.md"]) != nil)
        #expect(FileNameRule.validate("README.md", siblings: ["readme.md"], renaming: "readme.md") == nil)
        #expect(FileNameRule.validate("new.md", siblings: ["readme.md"]) == nil)
    }

    @Test func pathMapFollowsRenamesAndMoves() {
        #expect(PathMap.remap("src/a.ts", from: "src", to: "lib") == "lib/a.ts")
        #expect(PathMap.remap("src/a.ts", from: "src/a.ts", to: "src/b.ts") == "src/b.ts")
        #expect(PathMap.remap("src2/a.ts", from: "src", to: "lib") == "src2/a.ts")
        #expect(PathMap.affected(["src/a", "src2/b", "src"], by: "src") == ["src/a", "src"])
    }

    @Test func rootAndGitAreNeverTouched() throws {
        #expect(FileOps.protectedReason("") != nil)
        #expect(FileOps.protectedReason(".git") != nil)
        #expect(FileOps.protectedReason("sub/.git/config") != nil)
        #expect(FileOps.protectedReason("src/.gitignore") == nil)
        let (root, _) = try sandbox()
        try FileManager.default.createDirectory(atPath: root + "/.git", withIntermediateDirectories: false)
        #expect(FileOps.trash(root: root, path: ".git") == .failure(FileOpError(FileOps.protectedReason(".git")!)))
        #expect(FileManager.default.fileExists(atPath: root + "/.git"))
        if case .success = FileOps.trash(root: root, path: "") { Issue.record("root was trashed") }
    }

    @Test func clashNamesAddCopy() {
        #expect(FileOps.uniqueName("a.txt", taken: []) == "a.txt")
        #expect(FileOps.uniqueName("a.txt", taken: ["a.txt"]) == "a copy.txt")
        #expect(FileOps.uniqueName("a.txt", taken: ["A.txt", "a copy.txt"]) == "a copy 2.txt")
        #expect(FileOps.uniqueName("dir", taken: ["dir"]) == "dir copy")
        #expect(FileOps.uniqueName(".env", taken: [".env"]) == ".env copy")
    }

    @Test func moveChecks() {
        #expect(FileOps.checkMove(from: "a", toParent: "a/b") != nil)
        #expect(FileOps.checkMove(from: "a/x", toParent: "a") != nil)
        #expect(FileOps.checkMove(from: "a/x", toParent: "b") == nil)
        #expect(FileOps.checkMove(from: "a/x", toParent: "") == nil)
        #expect(FileOps.checkMove(from: ".git", toParent: "b") != nil)
        #expect(FileOps.checkMove(from: "a", toParent: ".git") != nil)
    }

    @Test func createRenameMoveAndClash() throws {
        let (root, _) = try sandbox()
        #expect(FileOps.create(root: root, parent: "", name: "d", isFolder: true) == .success("d"))
        #expect(FileOps.create(root: root, parent: "d", name: "f.txt", isFolder: false) == .success("d/f.txt"))
        if case .success = FileOps.create(root: root, parent: "d", name: "F.txt", isFolder: false) { Issue.record("clash allowed") }
        if case .success = FileOps.create(root: root, parent: "", name: "../x", isFolder: false) { Issue.record("slash allowed") }
        #expect(FileOps.move(root: root, from: "d/f.txt", toParent: "d", newName: "g.txt") == .success("d/g.txt"))
        #expect(FileOps.move(root: root, from: "d/g.txt", toParent: "", newName: "g.txt") == .success("g.txt"))
        #expect(FileOps.countItems(root: root, path: "d") == 0)
        #expect(FileOps.move(root: root, from: "d", toParent: "d", newName: "d") != .success("d"))
    }

    @Test func symlinkEscapesAreRefused() throws {
        let (root, outside) = try sandbox()
        try FileManager.default.createSymbolicLink(atPath: root + "/link", withDestinationPath: outside.path)
        // Creating or moving through a link that points out is refused.
        if case .success = FileOps.create(root: root, parent: "link", name: "x.txt", isFolder: false) { Issue.record("escaped") }
        #expect(!FileManager.default.fileExists(atPath: outside.path + "/x.txt"))
        _ = FileOps.create(root: root, parent: "", name: "f.txt", isFolder: false)
        if case .success = FileOps.move(root: root, from: "f.txt", toParent: "link", newName: "f.txt") { Issue.record("moved out") }
        if case .success = FileOps.copyIn(root: root, sources: [outside], toParent: "link") { Issue.record("copied out") }
        // The link itself can be renamed (it is not followed), and the file stays untouched outside.
        #expect(FileOps.move(root: root, from: "link", toParent: "", newName: "link2") == .success("link2"))
        #expect(FileManager.default.fileExists(atPath: outside.path))
        #expect(FileOps.itemURL(root: root, relative: "../x") == nil)
    }

    @Test func copyInNeverOverwrites() throws {
        let (root, outside) = try sandbox()
        let file = outside.appendingPathComponent("a.txt")
        try "one".write(to: file, atomically: true, encoding: .utf8)
        #expect(FileOps.copyIn(root: root, sources: [file], toParent: "") == .success(["a.txt"]))
        #expect(FileOps.copyIn(root: root, sources: [file], toParent: "") == .success(["a copy.txt"]))
        #expect(FileOps.copyIn(root: root, sources: [file, file], toParent: "") == .success(["a copy 2.txt", "a copy 3.txt"]))
        #expect(try String(contentsOfFile: root + "/a.txt", encoding: .utf8) == "one")
    }

    @Test func trashRefusesWhatIsGoneAndOutside() throws {
        let (root, _) = try sandbox()
        #expect(FileOps.trash(root: root, path: "nope") == .failure(FileOpError("That item is gone.")))
        #expect(FileOps.trash(root: root, path: "../x") == .failure(FileOpError("That item is gone.")))
    }
}

@Suite("Content search")
struct ContentSearchTests {
    @Test func parsesGitAndGrepLines() {
        #expect(ContentSearch.parseLine("src/a.ts:12:  let x = 1") == ContentHit(path: "src/a.ts", line: 12, snippet: "let x = 1"))
        #expect(ContentSearch.parseLine("./b.md:3:hi") == ContentHit(path: "b.md", line: 3, snippet: "hi"))
        #expect(ContentSearch.parseLine("a:b.txt:7:x:9:y") == ContentHit(path: "a:b.txt", line: 7, snippet: "x:9:y"))
        #expect(ContentSearch.parseLine(".git/config:1:x") == nil)
        #expect(ContentSearch.parseLine("Binary file x matches") == nil)
        #expect(ContentSearch.parseLine("a.txt:x:1") == nil)
    }

    @Test func snippetsAreClippedAndOutputIsCapped() {
        let long = String(repeating: "z", count: 500)
        #expect(ContentSearch.parseLine("a:1:\(long)")?.snippet.count == 200)
        let out = (1...500).map { "f.txt:\($0):hit" }.joined(separator: "\n")
        #expect(ContentSearch.parse(out).count == 200)
        #expect(ContentSearch.parse(out, cap: 5).map(\.line) == [1, 2, 3, 4, 5])
    }

    @Test func shortQueriesSearchNothing() {
        #expect(ContentSearch.normalized(" a ") == nil)
        #expect(ContentSearch.normalized(" ab ") == "ab")
        #expect(ContentSearch.run(root: "/tmp", query: "a", isCancelled: { false }).isEmpty)
    }

    @Test func runsAgainstARealFolder() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-grep-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "alpha\nNeedle here\n".write(to: dir.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
        let hits = ContentSearch.run(root: dir.path, query: "needle", isCancelled: { false })
        #expect(hits == [ContentHit(path: "a.txt", line: 2, snippet: "Needle here")])
        #expect(ContentSearch.run(root: dir.path, query: "needle", isCancelled: { true }).isEmpty)
    }
}
