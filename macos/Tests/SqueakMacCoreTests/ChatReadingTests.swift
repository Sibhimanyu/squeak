import Foundation
import Testing
@testable import SqueakMacCore

private let levels = ["low", "medium", "high", "xhigh", "max"]
private let models: [DaemonChatModel] = [
    DaemonChatModel(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: levels, defaultLevel: "medium"),
    DaemonChatModel(id: "sonnet-5-5-1m", agent: "claude", label: "Sonnet 5.5 · 1M", levels: levels, defaultLevel: "medium"),
    DaemonChatModel(id: "haiku-5-5", agent: "claude", label: "Haiku 5.5", levels: []),
    DaemonChatModel(id: "gpt-5.5", agent: "codex", label: "GPT 5.5", levels: ["low", "high"], defaultLevel: "high"),
]
private func prefs() -> ChatPresetPreferences { ChatPresetPreferences(defaults: UserDefaults(suiteName: "squeak.test.\(UUID().uuidString)")!) }
private func store() -> ChatSplitStore { ChatSplitStore(defaults: UserDefaults(suiteName: "squeak.test.\(UUID().uuidString)")!) }
private func step(_ kind: String, _ text: String, _ s: TimeInterval) -> ActivityStep {
    ActivityStep(kind: kind, text: text, at: Date(timeIntervalSince1970: 1_000 + s))
}

@Suite("Thoughts without a summary")
struct EmptyThoughtTests {
    @Test func aFinishedThoughtWithNoTextHasNoRow() {
        let block = TurnFolding.block(steps: [step("thinking", "", 0), step("tool", "Read a.ts", 3), step("thinking", "  \n", 5), step("thinking", "why", 6)], working: false)
        let all = block.folded + block.shown
        #expect(all.count == 2)
        guard case .tool = all[0], case .thinking(_, let text, _, _) = all[1] else { Issue.record("shape"); return }
        #expect(text == "why")
    }

    @Test func theLiveThinkingLineStaysWhileItWorks() {
        let block = TurnFolding.block(steps: [step("tool", "Read a.ts", 0), step("thinking", "", 3)], working: true)
        #expect((block.folded + block.shown).count == 2)
        #expect(TurnFolding.hasSummary("") == false)
        #expect(TurnFolding.hasSummary(" x ") == true)
    }
}

@Suite("Dock fade")
struct DockFadeTests {
    @Test func theBottomPaddingNeverFallsBelowTheFade() {
        #expect(DockFade.height >= 40 && DockFade.height <= 60)
        #expect(DockFade.bottomPadding(base: 16) >= DockFade.height)
        #expect(DockFade.bottomPadding(base: 200) == 200)
    }

    @Test func theColumnIs720InsideTheComposers760() {
        #expect(Tokens.Workbench.readingColumnMax - 2 * Tokens.Workbench.transcriptTextInset == 720)
    }
}

@Suite("Presets in a chat's model menu")
struct ChatPresetMenuTests {
    @Test func subtitleNamesTheModels() {
        let balanced = ChatPresets.setup(for: .balanced, agent: .claude, models: models)!
        #expect(ChatPresetMenu.subtitle(balanced, models: models) == "Opus 5.5 · Sonnet codes · Haiku runs")
        #expect(ChatPresetMenu.subtitle(ChatSetup(modelId: "haiku-5-5"), models: models) == "Haiku 5.5")
    }

    @Test func aPickedPresetIsCheckedUntilEditedAwayThenCustom() {
        let p = prefs()
        let save = ChatPresets.setup(for: .save, agent: .claude, models: models)!
        let record = ChatSplitRecord(preset: .save, setup: save)
        #expect(ChatPresetMenu.match(modelId: save.modelId, level: save.level, record: record, agent: .claude, models: models, preferences: p) == .preset(.save))
        // The level is changed by hand: Custom.
        #expect(ChatPresetMenu.match(modelId: save.modelId, level: "high", record: record, agent: .claude, models: models, preferences: p) == .custom)
        // Another model by hand: Custom.
        #expect(ChatPresetMenu.match(modelId: "opus-5-5-1m", level: "low", record: record, agent: .claude, models: models, preferences: p) == .custom)
        // Never picked here: nothing marked. Codex has no presets.
        #expect(ChatPresetMenu.match(modelId: save.modelId, level: save.level, record: nil, agent: .claude, models: models, preferences: p) == .none)
        #expect(ChatPresetMenu.match(modelId: "gpt-5.5", level: "high", record: record, agent: .codex, models: models, preferences: p) == .none)
    }

    @Test func theSplitIsPendingUntilTheNextMessageIsSent() {
        let s = store()
        let balanced = ChatPresets.setup(for: .balanced, agent: .claude, models: models)!
        #expect(s.record(for: "squeak:1") == nil)
        s.applied(.balanced, setup: balanced, chat: "squeak:1")
        #expect(s.record(for: "squeak:1")?.pending == true)
        s.messageSent(chat: "squeak:2")   // another chat: untouched
        #expect(s.record(for: "squeak:1")?.pending == true)
        s.messageSent(chat: "squeak:1")
        #expect(s.record(for: "squeak:1")?.pending == false)
        #expect(s.record(for: "squeak:1")?.preset == .balanced)   // still the chat's preset
        #expect(balanced.split == WorkSplit(code: "sonnet", run: "haiku", planFirst: nil))
    }

    @Test func theHostBodyCarriesTheSplit() async throws {
        let balanced = ChatPresets.setup(for: .balanced, agent: .claude, models: models)!
        #expect(balanced.split.nativeJSON == .object(["code": .string("sonnet"), "run": .string("haiku")]))
        // A preset with no split sends an empty object, which clears a pending one.
        #expect(WorkSplit().nativeJSON == .object([:]))
    }
}
