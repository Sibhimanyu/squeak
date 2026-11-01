import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct CallNewChatModelTests {
    private let models = [
        DaemonChatModel(id: "opus", agent: "claude", label: "Opus 5.5", levels: ["low", "high", "xhigh"], defaultLevel: "high"),
        DaemonChatModel(id: "haiku", agent: "claude", label: "Haiku", levels: []),
    ]
    private func view(_ json: String) throws -> VoiceSettings { try JSONDecoder().decode(VoiceSettings.self, from: Data(json.utf8)) }

    @Test func anOlderDaemonHidesTheRow() throws {
        let v = try view(#"{"mode":"gateway"}"#)
        #expect(v.chatModels == nil && v.newChatModel == nil)
    }

    @Test func decodesThePickAndThePresets() throws {
        let v = try view(#"{"newChatModel":{"id":"opus","level":"low"},"chatModels":[{"id":"opus","agent":"claude","label":"Opus 5.5","levels":["low"],"defaultLevel":"low"},{"bad":1}]}"#)
        #expect(v.newChatModel == CallNewChatModel(id: "opus", level: "low"))
        #expect(v.chatModels?.map(\.id) == ["opus"])
        #expect(try view(#"{"newChatModel":null,"chatModels":[]}"#).newChatModel == nil)
    }

    @Test func requestBodyCarriesThePickOrNull() throws {
        let some = try #require(try JSONSerialization.jsonObject(with: CallNewChatModel.requestBody(.init(id: "opus", level: "high"))) as? [String: Any])
        let inner = try #require(some["newChatModel"] as? [String: String])
        #expect(inner == ["id": "opus", "level": "high"])
        let none = try #require(try JSONSerialization.jsonObject(with: CallNewChatModel.requestBody(nil)) as? [String: Any])
        #expect(none["newChatModel"] is NSNull)
        let noLevel = try #require(try JSONSerialization.jsonObject(with: CallNewChatModel.requestBody(.init(id: "haiku"))) as? [String: Any])
        #expect((noLevel["newChatModel"] as? [String: String]) == ["id": "haiku"])
    }

    @Test func choosingTakesTheDefaultLevelOnlyWhenThereAreLevels() {
        #expect(CallNewChatModel.choosing("opus", in: models) == CallNewChatModel(id: "opus", level: "high"))
        #expect(CallNewChatModel.choosing("haiku", in: models) == CallNewChatModel(id: "haiku"))
        #expect(CallNewChatModel.choosing("gone", in: models) == nil)
        #expect(CallNewChatModel.choosing(nil, in: models) == nil)
    }

    @Test func levelChangesIgnoreUnknownLevels() {
        let p = CallNewChatModel(id: "opus", level: "high")
        #expect(p.with(level: "low", in: models).level == "low")
        #expect(p.with(level: "max", in: models).level == "high")
    }

    @Test func resolvedRepairsAStalePick() {
        #expect(CallNewChatModel(id: "gone").resolved(in: models) == nil)
        #expect(CallNewChatModel(id: "opus", level: "zzz").resolved(in: models)?.level == "high")
        #expect(CallNewChatModel(id: "haiku", level: "high").resolved(in: models) == CallNewChatModel(id: "haiku"))
    }

    @Test func summaryNamesTheModelAndLevel() {
        #expect(CallNewChatModel.summary(nil, in: models) == "Workspace's usual model")
        #expect(CallNewChatModel.summary(.init(id: "opus", level: "xhigh"), in: models) == "Opus 5.5 · Extra high")
        #expect(CallNewChatModel.summary(.init(id: "haiku"), in: models) == "Haiku")
    }
}
