import XCTest
@testable import SqueakCore

final class ChatPresetsTests: XCTestCase {
    private let levels = ["low", "medium", "high", "xhigh", "max"]
    private var models: [PhoneSnapshot.ChatModel] {
        [.init(id: "sonnet-5-5-1m", agent: "claude", label: "Sonnet 5.5 · 1M", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "opus-5-5", agent: "claude", label: "Opus 5.5", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "haiku-4-5", agent: "claude", label: "Haiku 4.5", levels: []),
         .init(id: "gpt-6.1-sol", agent: "codex", label: "GPT 6.1 Sol", levels: ["low", "high"], defaultLevel: "high", favorite: true)]
    }
    private let workers: [PhoneSnapshot.SplitWorker] = [.init(id: "sonnet", label: "Sonnet"), .init(id: "haiku", label: "Haiku"), .init(id: "opus", label: "Opus")]

    func testBestPlansWithOpus1MCodesWithOpusRunsWithSonnet() {
        let s = ChatPresets.setup(for: .best, agent: .claude, models: models, workers: workers)
        XCTAssertEqual(s, ChatSetup(modelId: "opus-5-5-1m", level: "high", code: "opus", run: "sonnet"))
    }

    func testBalancedOpusPlansSonnetCodesHaikuRuns() {
        let s = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers)
        XCTAssertEqual(s, ChatSetup(modelId: "opus-5-5", level: "medium", code: "sonnet", run: "haiku"))
        XCTAssertEqual(s?.split, WorkSplit(code: "sonnet", run: "haiku", planFirst: nil))
    }

    func testSaveUsageSonnetPlansHaikuCodesAndRuns() {
        let s = ChatPresets.setup(for: .save, agent: .claude, models: models, workers: workers)
        XCTAssertEqual(s, ChatSetup(modelId: "sonnet-5-5-1m", level: "low", code: "haiku", run: "haiku"))
    }

    func testAllThreeAreOfferedForClaudeEvenWithoutWorkers() {
        XCTAssertEqual(ChatPresets.available(agent: .claude, models: models, workers: workers), [.best, .balanced, .save])
        XCTAssertEqual(ChatPresets.available(agent: .claude, models: models, workers: []), [.best, .balanced, .save])
        XCTAssertNil(ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: [])?.code)
    }

    func testNeverNamesAWorkerTheMacDoesNotList() {
        let onlyHaiku: [PhoneSnapshot.SplitWorker] = [.init(id: "haiku", label: "Haiku")]
        let s = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: onlyHaiku)
        XCTAssertNil(s?.code); XCTAssertEqual(s?.run, "haiku")
    }

    func testFallsToTheNearestModelWhenAFamilyIsNotListed() {
        let onlyOpus = models.filter { $0.id.hasPrefix("opus") }
        XCTAssertEqual(ChatPresets.setup(for: .save, agent: .claude, models: onlyOpus, workers: workers)?.modelId, "opus-5-5")
        XCTAssertNil(ChatPresets.setup(for: .best, agent: .claude, models: models.filter { $0.agent == "codex" }, workers: workers))
    }

    func testCodexOffersNoPresets() {
        XCTAssertEqual(ChatPresets.available(agent: .codex, models: models, workers: workers), [])
        for preset in [ChatPreset.best, .balanced, .save] {
            XCTAssertNil(ChatPresets.setup(for: preset, agent: .codex, models: models, workers: workers))
        }
    }

    func testEditingAPresetMakesItCustom() {
        var s = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(ChatPresets.preset(of: s, agent: .claude, models: models, workers: workers), .balanced)
        s.planFirst = true
        XCTAssertEqual(ChatPresets.preset(of: s, agent: .claude, models: models, workers: workers), .custom)
    }

    func testDescriptionNamesWhoLeadsCodesAndRuns() {
        let balanced = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(ChatPresets.description(of: balanced, agent: .claude, models: models, workers: workers),
                       "Opus 5.5 leads · Sonnet codes · Haiku runs commands · medium effort")
        var asks = balanced; asks.planFirst = true
        XCTAssertTrue(ChatPresets.description(of: asks, agent: .claude, models: models, workers: workers).hasSuffix("· asks before changes"))
    }

    func testChangingOnlyTheLeadingModelKeepsThePreset() {
        var s = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers)!
        s.modelId = "sonnet-5-5"
        XCTAssertEqual(ChatPresets.preset(of: s, agent: .claude, models: models, workers: workers), .balanced)
    }

    func testSummaryInPlainWords() {
        let save = ChatPresets.setup(for: .save, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(ChatPresets.summary(of: save, agent: .claude, models: models, workers: workers),
                       "Sonnet 5.5 plans · Haiku codes · Haiku runs tests")
        var asks = save; asks.planFirst = true
        XCTAssertEqual(ChatPresets.summary(of: asks, agent: .claude, models: models, workers: workers),
                       "Sonnet 5.5 plans · Haiku codes · Haiku runs tests · asks before changes")
        let plain = ChatSetup(modelId: "opus-5-5", level: "high")
        XCTAssertEqual(ChatPresets.summary(of: plain, agent: .claude, models: models, workers: workers), "Opus 5.5 · high thinking")
    }

    func testStoreRemembersPresetAndCustomPerAgent() {
        let defaults = UserDefaults(suiteName: "chatpresets-\(UUID().uuidString)")!
        let store = ChatChoiceStore(defaults: defaults)
        XCTAssertEqual(store.restore(agent: .claude, models: models, workers: workers).modelId, "opus-5-5-1m")
        let save = ChatPresets.setup(for: .save, agent: .claude, models: models, workers: workers)!
        store.save(save, preset: .save, agent: .claude)
        XCTAssertEqual(store.restore(agent: .claude, models: models, workers: workers), save)
        var custom = save; custom.run = nil; custom.level = "low"
        store.save(custom, preset: .custom, agent: .claude)
        XCTAssertEqual(store.restore(agent: .claude, models: models, workers: workers), custom)
        // A worker the Mac stopped listing is dropped, never sent.
        XCTAssertNil(store.restore(agent: .claude, models: models, workers: [.init(id: "sonnet", label: "Sonnet")]).code)
        // Codex is untouched.
        XCTAssertEqual(store.restore(agent: .codex, models: models, workers: workers).modelId, "gpt-6.1-sol")
        store.lastWorkspace = "w1"
        XCTAssertEqual(ChatChoiceStore(defaults: defaults).lastWorkspace, "w1")
    }
}
