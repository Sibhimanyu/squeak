import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ComposerPickerTests {
    @Test func mentionAtStartAndAfterSpace() {
        #expect(ComposerTrigger.detect(in: "@src/ma", caret: 7) == .mention(query: "src/ma", range: NSRange(location: 0, length: 7)))
        #expect(ComposerTrigger.detect(in: "look at @re", caret: 11) == .mention(query: "re", range: NSRange(location: 8, length: 3)))
        #expect(ComposerTrigger.detect(in: "a\n@x tail", caret: 4) == .mention(query: "x", range: NSRange(location: 2, length: 2)))
    }

    @Test func mentionNeedsABoundaryAndNoSpace() {
        #expect(ComposerTrigger.detect(in: "mail me@x.com", caret: 13) == nil)
        #expect(ComposerTrigger.detect(in: "@a b", caret: 4) == nil)
        #expect(ComposerTrigger.detect(in: "hello", caret: 5) == nil)
        #expect(ComposerTrigger.detect(in: "", caret: 0) == nil)
        #expect(ComposerTrigger.detect(in: "x", caret: 9) == nil)
    }

    @Test func bareAtOpensWithEmptyQuery() {
        #expect(ComposerTrigger.detect(in: "see @", caret: 5) == .mention(query: "", range: NSRange(location: 4, length: 1)))
    }

    @Test func commandOnlyAtTheStart() {
        #expect(ComposerTrigger.detect(in: "/comp", caret: 5) == .command(query: "comp", range: NSRange(location: 0, length: 5)))
        #expect(ComposerTrigger.detect(in: "/", caret: 1) == .command(query: "", range: NSRange(location: 0, length: 1)))
        #expect(ComposerTrigger.detect(in: "/compact now", caret: 12) == nil)
        #expect(ComposerTrigger.detect(in: "run /usr/bin", caret: 12) == nil)
    }

    @Test func emojiBeforeCaretUsesUTF16() {
        let t = "😀 @a"
        #expect(ComposerTrigger.detect(in: t, caret: 5) == .mention(query: "a", range: NSRange(location: 3, length: 2)))
    }

    @Test func fuzzyIsASubsequenceMatch() {
        #expect(FuzzyMatch.score("xyz", in: "src/main.ts") == nil)
        #expect(FuzzyMatch.score("smt", in: "src/main.ts") != nil)
        #expect(FuzzyMatch.score("MAIN", in: "src/main.ts") != nil)
    }

    @Test func fuzzyRanksNamesAndBoundariesFirst() {
        let files = ["docs/readme-notes.md", "src/deep/reader.ts", "README.md", "a/b/c/r_e_a_d.txt"]
        let r = FuzzyMatch.rank("readme", files, limit: 10, key: { $0 })
        #expect(r.first == "README.md")
        #expect(!r.contains("src/deep/reader.ts"))
        #expect(FuzzyMatch.rank("", files, limit: 2, key: { $0 }) == Array(files.prefix(2)))
    }

    @Test func fuzzyPrefersContiguous() {
        let r = FuzzyMatch.rank("conf", ["src/cool_old_nice_file.ts", "src/config.ts"], limit: 5, key: { $0 })
        #expect(r.first == "src/config.ts")
    }

    @Test func slashCommandsFromTheLatestInit() {
        func row(_ seq: Int, _ cmds: [String]) -> NativeMessage {
            NativeMessage(seq: seq, role: "agent", kind: "system/init",
                          payload: .object(["slash_commands": .array(cmds.map(NativeJSON.string))]))
        }
        let old = row(1, ["old"]), new = row(5, ["/review", "compact", "compact", "init"])
        let other = NativeMessage(seq: 6, role: "agent", kind: "assistant", payload: .null)
        #expect(SlashCommands.fromInit([old, new, other]).map(\.name) == ["compact", "init", "review"])
        #expect(SlashCommands.fromInit([other]).isEmpty)
    }

    @Test func customCommandsReadFoldersAndDescriptions() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cmds-\(UUID().uuidString)").path
        defer { try? fm.removeItem(atPath: root) }
        let proj = root + "/proj/.claude/commands", home = root + "/home/.claude/commands"
        try fm.createDirectory(atPath: proj + "/git", withIntermediateDirectories: true)
        try fm.createDirectory(atPath: home, withIntermediateDirectories: true)
        try "# Ship it\nbody".write(toFile: proj + "/ship.md", atomically: true, encoding: .utf8)
        try "---\ndescription: Open a PR\n---\nbody".write(toFile: proj + "/git/pr.md", atomically: true, encoding: .utf8)
        try "user ship".write(toFile: home + "/ship.md", atomically: true, encoding: .utf8)
        try "note".write(toFile: home + "/readme.txt", atomically: true, encoding: .utf8)
        let found = SlashCommands.custom(cwd: root + "/proj", home: root + "/home")
        #expect(found.map(\.name) == ["git:pr", "ship"])
        #expect(found.first { $0.name == "ship" }?.detail == "Ship it")
        #expect(found.first { $0.name == "git:pr" }?.detail == "Open a PR")
        let merged = SlashCommands.merged([SlashCommand(name: "ship"), SlashCommand(name: "compact")], custom: found)
        #expect(merged.first { $0.name == "ship" }?.detail == "Ship it")
    }

    @Test func fileListParsesDedupesAndCaps() {
        #expect(WorkspaceFileIndex.parse("a\n\nb\na\n") == ["a", "b"])
        let big = (0..<(WorkspaceFileIndex.cap + 50)).map { "f\($0)" }.joined(separator: "\n")
        #expect(WorkspaceFileIndex.parse(big).count == WorkspaceFileIndex.cap)
    }

    @Test func fileIndexCachesPerFolderFor30Seconds() async {
        final class Box: @unchecked Sendable { var t = Date(timeIntervalSince1970: 1000); var calls = 0 }
        let box = Box()
        let index = WorkspaceFileIndex(now: { box.t }, list: { _ in box.calls += 1; return ["x"] })
        _ = await index.files(in: "/a"); _ = await index.files(in: "/a")
        #expect(box.calls == 1)
        _ = await index.files(in: "/b")
        #expect(box.calls == 2)
        box.t = box.t.addingTimeInterval(31)
        _ = await index.files(in: "/a")
        #expect(box.calls == 3)
    }

    @Test func gitListReadsARealRepo() async throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent("gl-\(UUID().uuidString)").path
        try fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(atPath: dir) }
        func git(_ a: [String]) throws {
            let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/git"); p.arguments = ["-C", dir] + a
            p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
            try p.run(); p.waitUntilExit()
        }
        try git(["init", "-q"])
        try "1".write(toFile: dir + "/tracked.txt", atomically: true, encoding: .utf8)
        try "1".write(toFile: dir + "/new file.txt", atomically: true, encoding: .utf8)
        try "ignored.log\n".write(toFile: dir + "/.gitignore", atomically: true, encoding: .utf8)
        try "1".write(toFile: dir + "/ignored.log", atomically: true, encoding: .utf8)
        try git(["add", "tracked.txt"])
        let files = WorkspaceFileIndex.gitList(in: dir)
        #expect(Set(files) == [".gitignore", "new file.txt", "tracked.txt"])
        #expect(WorkspaceFileIndex.gitList(in: dir + "/missing").isEmpty)
    }
}
