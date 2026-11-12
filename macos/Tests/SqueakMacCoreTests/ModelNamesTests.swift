import Foundation
import Testing
@testable import SqueakMacCore

@Suite("ModelNames")
struct ModelNamesTests {
    @Test("Claude CLI ids, Conductor aliases, Codex ids and unknown ids all read as names")
    func table() {
        let rows: [(String, String)] = [
            ("claude-opus-5-5", "Opus 5.5"),
            ("claude-opus-5-5[1m]", "Opus 5.5 · 1M"),
            ("claude-sonnet-5-5", "Sonnet 5.5"),
            ("claude-haiku-4-5-20251001", "Haiku 4.5"),
            ("opus-5-1m", "Opus 5 · 1M"),
            ("opus-5-5-1m", "Opus 5.5 · 1M"),
            ("opus", "Opus"),
            ("sonnet", "Sonnet"),
            ("fable-5-2", "Fable 5.2"),
            ("gpt-6.1-sol", "GPT 6.1 Sol"),
            ("gpt-5.4", "GPT 5.4"),
            ("my-local_model[x]", "My Local Model X"),
        ]
        for (raw, shown) in rows { #expect(ModelNames.display(raw) == shown, "\(raw)") }
    }

    @Test("The composer label names the native chat's CLI id, with the effort beside it")
    func composer() {
        let catalog = [DaemonChatModel(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: ["medium"])]
        #expect(ModelNames.composerLabel(model: "claude-opus-5-5[1m]", effort: "medium", in: []) == "Opus 5.5 · 1M · Medium")
        #expect(ModelNames.composerLabel(model: "claude-opus-5-5[1m]", effort: "medium", in: catalog) == "Opus 5.5 · 1M · Medium")
        #expect(ModelNames.match("claude-opus-5-5[1m]", in: catalog)?.id == "opus-5-5-1m")
        #expect(ModelNames.composerLabel(model: "gpt-6.1-sol", effort: nil, in: []) == "GPT 6.1 Sol")
    }
}
