import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct VoicePersonaTests {
    private func decode(_ json: String) throws -> VoiceSettings {
        try JSONDecoder().decode(VoiceSettings.self, from: Data(json.utf8))
    }

    @Test func aDaemonWithoutPersonasHidesTheSection() throws {
        #expect(try decode(#"{"mode":"gateway"}"#).persona == nil)
    }

    @Test func readsTheStyleAndItsDescription() throws {
        let terse = try decode(#"{"mode":"gateway","persona":{"style":"terse"}}"#).persona
        #expect(terse == VoicePersona(style: .terse))
        let custom = try decode(#"{"mode":"gateway","persona":{"style":"custom","custom":"dry and blunt"}}"#).persona
        #expect(custom == VoicePersona(style: .custom, custom: "dry and blunt"))
        // An unknown style from a newer daemon falls back to terse rather than hiding the setting.
        #expect(try decode(#"{"persona":{"style":"pirate"}}"#).persona?.style == .terse)
    }

    @Test func aCustomCharacterNeedsItsDescription() {
        #expect(VoicePersona(style: .terse).isSavable)
        #expect(VoicePersona(style: .friendly, custom: "").isSavable)
        #expect(!VoicePersona(style: .custom, custom: "   \n ").isSavable)
        #expect(VoicePersona(style: .custom, custom: "dry").isSavable)
    }

    @Test func theDescriptionTravelsOnlyWithTheCustomStyleCleanedAndClipped() throws {
        func body(_ persona: VoicePersona) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: persona.requestBody()) as? [String: Any])
        }
        let terse = try body(VoicePersona(style: .terse, custom: "left over"))
        #expect(terse.count == 1)
        let inner = try #require(terse["persona"] as? [String: Any])
        #expect(inner.count == 1 && inner["style"] as? String == "terse")

        let custom = try body(VoicePersona(style: .custom, custom: "  dry \n and   blunt "))
        let customInner = try #require(custom["persona"] as? [String: Any])
        #expect(customInner["style"] as? String == "custom")
        #expect(customInner["custom"] as? String == "dry and blunt")

        let long = String(repeating: "x", count: 900)
        #expect(VoicePersona.cleaned(long).count == VoicePersona.maxCustomLength)
    }
}
