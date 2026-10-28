import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct VoiceSettingsTests {
    @Test func onlyAnInternalExtensionIsAnExtension() {
        for ok in ["10", "101", "35217", "123456"] { #expect(VoiceSettings.isExtension(ok)) }
        for bad in ["", "1", "1234567", "+919876543210", "10 1", "10a", "١٠١"] { #expect(!VoiceSettings.isExtension(bad)) }
    }

    @Test func emptyTextClearsTheSetting() {
        #expect(VoiceSettings.normalized("  ") == nil)
        #expect(VoiceSettings.normalized(" 101 ") == "101")
    }

    @Test func requestBodyIsOneKey() throws {
        let set = try JSONSerialization.jsonObject(with: VoiceSettings.requestBody(callee: "101")) as? [String: Any]
        #expect(set?.count == 1 && set?["callee"] as? String == "101")
        let cleared = try JSONSerialization.jsonObject(with: VoiceSettings.requestBody(callee: nil)) as? [String: Any]
        #expect(cleared?.count == 1 && cleared?["callee"] is NSNull)
    }

    @Test func decodesTheDaemonsAnswer() throws {
        let body = Data(#"{"mode":"gateway","callee":"101","defaultCallee":null}"#.utf8)
        let v = try JSONDecoder().decode(VoiceSettings.self, from: body)
        #expect(v == VoiceSettings(mode: "gateway", callee: "101", defaultCallee: nil) && v.isOn)
    }

    @Test func voiceIsLinkableAndGrouped() {
        #expect(SettingsSection(link: "calls") == .voice)
        #expect(SettingsSection.groups.flatMap { $0 }.contains(.voice))
    }
}
