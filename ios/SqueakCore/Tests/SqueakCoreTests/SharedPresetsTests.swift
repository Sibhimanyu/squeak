import Foundation
import XCTest
@testable import SqueakCore

/// Pins the shared `presets` view, how a preset resolves from it, and the signed `presets` command to
/// docs/remote-channel.md, "New chat presets".
final class SharedPresetsTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()
    private let levels = ["low", "medium", "high"]
    private var models: [PhoneSnapshot.ChatModel] {
        [.init(id: "sonnet-5-5-1m", agent: "claude", label: "Sonnet 5.5 · 1M", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: levels, defaultLevel: "medium", favorite: true),
         .init(id: "haiku-4-5", agent: "claude", label: "Haiku 4.5", levels: []),
         .init(id: "gpt-6.1-sol", agent: "codex", label: "GPT 6.1 Sol", levels: ["low", "high"], defaultLevel: "high", favorite: true)]
    }
    private let workers: [PhoneSnapshot.SplitWorker] = [.init(id: "sonnet", label: "Sonnet"), .init(id: "haiku", label: "Haiku")]

    private func decode(_ text: String) throws -> ChatPresetsDocument {
        try JSONDecoder().decode(ChatPresetsDocument.self, from: Data(text.utf8))
    }

    /* ---------- view ---------- */

    func testDecodesTheDocumentedView() throws {
        let doc = try decode("""
        {"names":{"save":"Cheap"},"setups":{
          "claude":{"save":{"modelId":"opus-5-5-1m","level":"low","code":"sonnet","run":"haiku","planFirst":true}},
          "codex":{"best":{"modelId":"gpt-6.1-sol","level":"high","code":null,"run":null,"planFirst":false}}}}
        """)
        XCTAssertEqual(doc.names, ["save": "Cheap"])
        XCTAssertEqual(doc.setups["claude"]?["save"], ChatSetup(modelId: "opus-5-5-1m", level: "low", code: "sonnet", run: "haiku", planFirst: true))
        XCTAssertEqual(doc.setups["codex"]?["best"], ChatSetup(modelId: "gpt-6.1-sol", level: "high"))
    }

    func testEmptyStoreDecodesAndAbsentPresetsStaysNil() throws {
        XCTAssertEqual(try decode(#"{"names":{},"setups":{}}"#), ChatPresetsDocument())
        let view = try JSONDecoder().decode(PhoneSnapshot.self, from: Data(#"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#.utf8))
        XCTAssertNil(view.presets)
        let with = try JSONDecoder().decode(PhoneSnapshot.self, from: Data(#"{"v":1,"mac":"Mac","generatedAt":"2026-10-19T00:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[],"presets":{"names":{},"setups":{}}}"#.utf8))
        XCTAssertEqual(with.presets, ChatPresetsDocument())
    }

    /* ---------- resolution ---------- */

    func testAbsentPresetsIsTodaysBehaviourExactly() {
        for agent in NewChatAgent.allCases {
            for preset in [ChatPreset.best, .balanced, .save] {
                XCTAssertEqual(ChatPresets.setup(for: preset, agent: agent, models: models, workers: workers, shared: nil),
                               ChatPresets.setup(for: preset, agent: agent, models: models, workers: workers))
                XCTAssertEqual(ChatPresets.setup(for: preset, agent: agent, models: models, workers: workers, shared: ChatPresetsDocument()),
                               ChatPresets.setup(for: preset, agent: agent, models: models, workers: workers))
            }
        }
        XCTAssertEqual(ChatPresets.name(of: .save, shared: nil), "Save usage")
        XCTAssertEqual(ChatPresets.name(of: .save, shared: ChatPresetsDocument()), "Save usage")
    }

    func testStoredSetupReplacesTheBuiltInForThatAgentOnly() throws {
        let doc = try decode(#"{"names":{},"setups":{"claude":{"save":{"modelId":"opus-5-5-1m","level":"low","code":"sonnet","run":"haiku","planFirst":true}}}}"#)
        XCTAssertEqual(ChatPresets.setup(for: .save, agent: .claude, models: models, workers: workers, shared: doc),
                       ChatSetup(modelId: "opus-5-5-1m", level: "low", code: "sonnet", run: "haiku", planFirst: true))
        XCTAssertEqual(ChatPresets.setup(for: .best, agent: .claude, models: models, workers: workers, shared: doc),
                       ChatPresets.setup(for: .best, agent: .claude, models: models, workers: workers))
    }

    func testNameIsSharedAndBlankMeansBuiltIn() throws {
        let doc = try decode(#"{"names":{"save":"  Cheap ","best":"  "},"setups":{}}"#)
        XCTAssertEqual(ChatPresets.name(of: .save, shared: doc), "Cheap")
        XCTAssertEqual(ChatPresets.name(of: .best, shared: doc), "Best")
        XCTAssertEqual(ChatPresets.name(of: .balanced, shared: doc), "Balanced")
    }

    func testStoredSetupIsKeptOnWhatTheMacListsNow() throws {
        // A level the model does not take becomes its default; an unlisted worker goes; no worker, no plan first.
        let doc = try decode(#"{"names":{},"setups":{"claude":{"balanced":{"modelId":"opus-5-5-1m","level":"xhigh","code":"fable","run":null,"planFirst":true}}}}"#)
        XCTAssertEqual(ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers, shared: doc),
                       ChatSetup(modelId: "opus-5-5-1m", level: "medium"))
        // A model the Mac no longer lists: the built-in stands.
        let gone = try decode(#"{"names":{},"setups":{"claude":{"balanced":{"modelId":"retired","level":null,"code":"sonnet","run":null,"planFirst":false}}}}"#)
        XCTAssertEqual(ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers, shared: gone),
                       ChatPresets.setup(for: .balanced, agent: .claude, models: models, workers: workers))
        // A model with no levels has none.
        let flat = try decode(#"{"names":{},"setups":{"claude":{"best":{"modelId":"haiku-4-5","level":"high","code":null,"run":null,"planFirst":false}}}}"#)
        XCTAssertEqual(ChatPresets.setup(for: .best, agent: .claude, models: models, workers: workers, shared: flat), ChatSetup(modelId: "haiku-4-5"))
    }

    func testCodexNeverDelegates() throws {
        let doc = try decode(#"{"names":{},"setups":{"codex":{"best":{"modelId":"gpt-6.1-sol","level":"low","code":"sonnet","run":"haiku","planFirst":true}}}}"#)
        XCTAssertEqual(ChatPresets.setup(for: .best, agent: .codex, models: models, workers: workers, shared: doc),
                       ChatSetup(modelId: "gpt-6.1-sol", level: "low"))
    }

    func testAvailabilityAndPresetOfFollowTheStoredSetups() throws {
        // No workers: only Best resolves from the built-in rule, so nothing is offered; a stored Save makes two.
        XCTAssertEqual(ChatPresets.available(agent: .claude, models: models, workers: []), [])
        let doc = try decode(#"{"names":{},"setups":{"claude":{"save":{"modelId":"sonnet-5-5-1m","level":"low","code":null,"run":null,"planFirst":false}}}}"#)
        XCTAssertEqual(ChatPresets.available(agent: .claude, models: models, workers: [], shared: doc), [.best, .save])
        let stored = ChatSetup(modelId: "sonnet-5-5-1m", level: "low")
        XCTAssertEqual(ChatPresets.preset(of: stored, agent: .claude, models: models, workers: [], shared: doc), .save)
        XCTAssertEqual(ChatPresets.preset(of: stored, agent: .claude, models: models, workers: []), .custom)
    }

    /* ---------- command ---------- */

    private indirect enum J: Codable, Equatable {
        case null, bool(Bool), string(String), int(Int64), object([String: J])
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null }
            else if let v = try? c.decode(Bool.self) { self = .bool(v) }
            else if let v = try? c.decode(Int64.self) { self = .int(v) }
            else if let v = try? c.decode(String.self) { self = .string(v) }
            else { self = .object(try c.decode([String: J].self)) }
        }
        func encode(to encoder: Encoder) throws { fatalError() }
    }

    private func open(_ change: PresetsChange) throws -> [String: J] {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let ch = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, doc) = try ch.presetsDocument(change, signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        return try ChannelCrypto.open([String: J].self, box: doc.box, key: key)
    }

    func testSetupCommandIsOneWholeSetup() throws {
        let json = try open(.setup(agent: .claude, preset: .save, ChatSetup(modelId: "opus-5-5-1m", level: "low", code: "sonnet", run: "haiku", planFirst: true)))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "agent", "preset", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"], .string("presets"))
        XCTAssertEqual(json["v"], .int(1))
        XCTAssertEqual(json["agent"], .string("claude"))
        XCTAssertEqual(json["preset"], .string("save"))
        XCTAssertEqual(json["change"], .object(["setup": .object([
            "modelId": .string("opus-5-5-1m"), "level": .string("low"), "code": .string("sonnet"),
            "run": .string("haiku"), "planFirst": .bool(true)])]))
    }

    func testUnsetPartsAreExplicitNulls() throws {
        let json = try open(.setup(agent: .codex, preset: .best, ChatSetup(modelId: "gpt-6.1-sol")))
        XCTAssertEqual(json["change"], .object(["setup": .object([
            "modelId": .string("gpt-6.1-sol"), "level": .null, "code": .null, "run": .null, "planFirst": .bool(false)])]))
    }

    func testNameCommandHasNoAgent() throws {
        let json = try open(.name(preset: .save, "Cheap"))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "preset", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["change"], .object(["name": .string("Cheap")]))
        let cleared = try open(.name(preset: .save, nil))
        XCTAssertEqual(cleared["change"], .object(["name": .null]))
    }

    func testResetCommand() throws {
        let json = try open(.reset(agent: .codex, preset: .balanced))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "agent", "preset", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["agent"], .string("codex"))
        XCTAssertEqual(json["change"], .object(["reset": .bool(true)]))
    }

    /* ---------- optimistic overlay ---------- */

    func testChangesApplyLikeTheMacDoes() {
        var doc = ChatPresetsDocument()
        PresetsChange.name(preset: .save, "  Cheap ").apply(to: &doc)
        XCTAssertEqual(doc.names, ["save": "Cheap"])
        PresetsChange.name(preset: .save, "Save usage").apply(to: &doc)
        XCTAssertEqual(doc.names, [:])
        PresetsChange.setup(agent: .claude, preset: .best, ChatSetup(modelId: "m")).apply(to: &doc)
        PresetsChange.name(preset: .best, "Top").apply(to: &doc)
        XCTAssertNotNil(doc.setups["claude"]?["best"])
        PresetsChange.reset(agent: .claude, preset: .best).apply(to: &doc)
        XCTAssertEqual(doc, ChatPresetsDocument())
    }
}
