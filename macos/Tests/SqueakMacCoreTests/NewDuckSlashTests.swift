import Foundation
import Testing
@testable import SqueakMacCore

struct NewDuckSlashTests {
    private func home() throws -> String {
        let d = NSTemporaryDirectory() + "nds-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: d + "/.claude/skills/mine", withIntermediateDirectories: true)
        try "---\ndescription: Mine\n---\n".write(toFile: d + "/.claude/skills/mine/SKILL.md", atomically: true, encoding: .utf8)
        return d
    }

    @Test func claudeUsesTheHostList() async throws {
        let h = try home(); defer { try? FileManager.default.removeItem(atPath: h) }
        let out = await NewDuckSlash.list(agent: .claude, cwd: nil, home: h) { [SlashCommand(name: "plug:grill", detail: "G", plugin: "plug")] }
        #expect(out.map(\.name) == ["plug:grill"])
    }

    @Test func claudeFallsBackToTheLocalScanWhenTheHostIsSilent() async throws {
        let h = try home(); defer { try? FileManager.default.removeItem(atPath: h) }
        let out = await NewDuckSlash.list(agent: .claude, cwd: nil, home: h) { [] }
        #expect(out.map(\.name) == ["mine"])
    }

    @Test func codexNeverAsksTheClaudeHost() async throws {
        let h = try home(); defer { try? FileManager.default.removeItem(atPath: h) }
        let out = await NewDuckSlash.list(agent: .codex, cwd: nil, home: h) { Issue.record("asked the host"); return [] }
        #expect(out.map(\.name) == ["mine"])
    }

    @Test func identityChangesWithAgentAndFolder() {
        #expect(NewDuckSlash.identity(agent: .claude, folder: "/a") != NewDuckSlash.identity(agent: .codex, folder: "/a"))
        #expect(NewDuckSlash.identity(agent: .claude, folder: "/a") != NewDuckSlash.identity(agent: .claude, folder: "/b"))
    }

    @Test func blockSitsAboveTrueCentre() {
        // 800 free of 1000 with a 200 block: 800 * 0.42 above, the rest below.
        #expect(abs(NewDuckLayout.top(viewport: 1000, content: 200) - 336) < 0.0001)
        #expect(NewDuckLayout.top(viewport: 1000, content: 200) < (1000 - 200) / 2)
    }

    @Test func aTallBlockStartsAtTheTopAndScrolls() {
        #expect(NewDuckLayout.top(viewport: 500, content: 500) == 0)
        #expect(NewDuckLayout.top(viewport: 500, content: 900) == 0)
        #expect(NewDuckLayout.height(viewport: 500, content: 900) == 900)
        #expect(NewDuckLayout.height(viewport: 500, content: 200) == 500)
    }
}
