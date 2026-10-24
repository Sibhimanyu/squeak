import XCTest
@testable import SqueakCore

final class ChatPresetsTests: XCTestCase {
    private let levels = ["low", "medium", "high", "xhigh", "max"]
    private var models: [PhoneSnapshot.ChatModel] {
        [.init(id: "sonnet-5-5-1m", agent: "claude", label: "Sonnet 5.5 · 1M", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "haiku-4-5", agent: "claude", label: "Haiku 4.5", levels: []),
         .init(id: "gpt-6.1-sol", agent: "codex", label: "GPT 6.1 Sol", levels: ["low", "high"], defaultLevel: "high", favorite: true)]
    }
    private let workers: [PhoneSnapshot.SplitWorker] = [.init(id: "sonnet", label: "Sonnet"), .init(id: "haiku", label: "Haiku"), .init(id: "opus", label: "Opus")]

    func testBestIsTheStrongestModelWithoutASplit() {
        let s = ChatPresets.setup(for: .best, agent: .claude, models: models, workers: workers)
        XCTAssertEqual(s, ChatSetup(modelId: "opus-5-5-1m", level: "high"))
        XCTAssertTrue(s!.split.isEmpty)
    }

    func testBalancedPlansStrongAndCodesWithSonnet() {
        let s = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(s.modelId, "opus-5-5-1m"); XCTAssertEqual(s.code, "sonnet"); XCTAssertNil(s.run); XCTAssertFalse(s.planFirst)
    }

    func testSaveUsageSplitsEverythingAndPlansFirst() {
        let s = ChatPresets.setup(for: .save, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(s, ChatSetup(modelId: "sonnet-5-5-1m", level: "medium", code: "sonnet", run: "haiku", planFirst: true))
        XCTAssertEqual(s.split, WorkSplit(code: "sonnet", run: "haiku", planFirst: true))
    }

    func testNoWorkersMeansNoSplitPresets() {
        XCTAssertEqual(ChatPresets.available(agent: .claude, models: models, workers: []), [])
        XCTAssertNil(ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: []))
        XCTAssertEqual(ChatPresets.available(agent: .claude, models: models, workers: workers), [.best, .balanced, .save])
    }

    func testNeverNamesAWorkerTheMacDoesNotList() {
        let onlyHaiku: [PhoneSnapshot.SplitWorker] = [.init(id: "haiku", label: "Haiku")]
        XCTAssertNil(ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: onlyHaiku))
        XCTAssertNil(ChatPresets.setup(for: .save, agent: .claude, models: models, workers: onlyHaiku))
    }

    func testCodexOffersNoPresetsAndNoSplit() {
        XCTAssertEqual(ChatPresets.available(agent: .codex, models: models, workers: workers), [])
        XCTAssertNil(ChatPresets.setup(for: .save, agent: .codex, models: models, workers: workers))
        XCTAssertEqual(ChatPresets.setup(for: .best, agent: .codex, models: models, workers: workers)?.modelId, "gpt-6.1-sol")
    }

    func testEditingAPresetMakesItCustom() {
        var s = ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(ChatPresets.preset(of: s, agent: .claude, models: models, workers: workers), .balanced)
        s.planFirst = true
        XCTAssertEqual(ChatPresets.preset(of: s, agent: .claude, models: models, workers: workers), .custom)
    }

    func testSummaryInPlainWords() {
        let save = ChatPresets.setup(for: .save, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(ChatPresets.summary(of: save, agent: .claude, models: models, workers: workers),
                       "Sonnet 5.5 plans · Sonnet codes · Haiku runs tests · asks before changes")
        let best = ChatPresets.setup(for: .best, agent: .claude, models: models, workers: workers)!
        XCTAssertEqual(ChatPresets.summary(of: best, agent: .claude, models: models, workers: workers), "Opus 5.5 · high thinking")
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
        XCTAssertNil(store.restore(agent: .claude, models: models, workers: [.init(id: "haiku", label: "Haiku")]).code)
        // Codex is untouched.
        XCTAssertEqual(store.restore(agent: .codex, models: models, workers: workers).modelId, "gpt-6.1-sol")
        store.lastWorkspace = "w1"
        XCTAssertEqual(ChatChoiceStore(defaults: defaults).lastWorkspace, "w1")
    }
}
