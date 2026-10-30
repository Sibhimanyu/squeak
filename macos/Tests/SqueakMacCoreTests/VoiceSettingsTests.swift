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

@Suite struct PinControlTests {
    private func json(_ a: PinAction) throws -> [String: Any] {
        let o = try JSONSerialization.jsonObject(with: a.requestBody()) as? [String: Any]
        return try #require(o?["pin"] as? [String: Any])
    }

    @Test func everyActionHasExactlyItsKeys() throws {
        let c = try json(.change(current: "1111", next: "2222"))
        #expect(c.count == 3 && c["action"] as? String == "change" && c["current"] as? String == "1111" && c["next"] as? String == "2222")
        let d = try json(.disable(current: "1111"))
        #expect(d.count == 2 && d["action"] as? String == "disable" && d["current"] as? String == "1111")
        let e = try json(.enable(next: "2222"))
        #expect(e.count == 2 && e["action"] as? String == "enable" && e["next"] as? String == "2222")
        let r = try json(.reset(next: "3333"))
        #expect(r.count == 2 && r["action"] as? String == "reset" && r["next"] as? String == "3333")
        let off = try json(.reset(next: nil))
        #expect(off.count == 2 && off["action"] as? String == "reset" && off["next"] is NSNull)
    }

    @Test func validationIsFourToTwelveDigits() {
        for ok in ["1234", "123456789012"] { #expect(PinRules.isValid(ok)) }
        for bad in ["", "123", "1234567890123", "12a4", "12 34", "١٢٣٤"] { #expect(!PinRules.isValid(bad)) }
        #expect(PinRules.problem(new: "1234", repeated: "1234") == nil)
        #expect(PinRules.problem(new: "1234", repeated: "1235") != nil)
        #expect(PinRules.problem(new: "12", repeated: "12") != nil)
    }

    @Test func decodesThePinFieldAndItsAbsence() throws {
        for (raw, state) in [("set", PinState.set), ("off", .off), ("none", .none), ("unknown", .unknown)] {
            let v = try JSONDecoder().decode(VoiceSettings.self, from: Data(#"{"mode":"direct","pin":"\#(raw)"}"#.utf8))
            #expect(v.pinState == state)
        }
        let old = try JSONDecoder().decode(VoiceSettings.self, from: Data(#"{"mode":"direct","callee":null}"#.utf8))
        #expect(old.pin == nil && old.pinState == nil)
    }

    @Test func effectivePolicyFollowsPinStateWithoutChangingSavedChoices() throws {
        for mode in ["direct", "gateway"] {
            for choice in PinPolicyChoice.allCases {
                for incoming in [false, true] {
                    let policy = PinPolicy(outgoing: choice, incoming: choice)
                    var view = VoiceSettings(mode: mode, pin: "set", policy: policy)
                    #expect(PinPolicyText.effective(state: view.pinState, choice: choice, incoming: incoming)
                            == (choice == .ask ? "Ask for the PIN" : "Don't ask"))
                    view.pin = "off"
                    #expect(PinPolicyText.effective(state: view.pinState, choice: choice, incoming: incoming)
                            == "No PIN required (PIN is off)")
                    view.pin = "none"
                    let withoutPin = choice == .skip ? "No PIN required"
                        : (incoming ? "Unavailable until a PIN is set" : "Read-only until a PIN is set")
                    #expect(PinPolicyText.effective(state: view.pinState, choice: choice, incoming: incoming) == withoutPin)
                    for unknown in ["unknown", "future-status", nil] {
                        view.pin = unknown
                        #expect(PinPolicyText.effective(state: view.pinState, choice: choice, incoming: incoming)
                                == "PIN status unavailable")
                    }
                    view.pin = "set"
                    #expect(view.policy == policy)
                    #expect(PinPolicyText.effective(state: view.pinState, choice: choice, incoming: incoming)
                            == (choice == .ask ? "Ask for the PIN" : "Don't ask"))
                }
            }
        }
    }

    @Test func refusalReasonComesFromTheError() {
        #expect(PinOutcome.reason(from: Data(#"{"error":"That is not your PIN."}"#.utf8)) == "That is not your PIN.")
        #expect(PinOutcome.reason(from: Data("nope".utf8)) == "Squeak could not do that.")
    }

    @Test func policyBodyIsByteExactWithSortedKeys() {
        let b = PinAction.policy(outgoing: .skip, incoming: .ask).requestBody()
        #expect(String(decoding: b, as: UTF8.self) == #"{"pin":{"action":"policy","incoming":"ask","outgoing":"skip"}}"#)
    }

    @Test func decodesPolicyAndToleratesUnknown() throws {
        let d = JSONDecoder()
        let v = try d.decode(VoiceSettings.self, from: Data(#"{"mode":"direct","policy":{"outgoing":"skip","incoming":"ask"}}"#.utf8))
        #expect(v.policy == PinPolicy(outgoing: .skip, incoming: .ask))
        let odd = try d.decode(VoiceSettings.self, from: Data(#"{"mode":"direct","policy":{"outgoing":"maybe","incoming":7}}"#.utf8))
        #expect(odd.policy == PinPolicy(outgoing: .ask, incoming: .ask))
        let none = try d.decode(VoiceSettings.self, from: Data(#"{"mode":"direct"}"#.utf8))
        #expect(none.policy == nil)
    }
}

@Suite struct NaturalVoiceTests {
    @Test func decodesTheDaemonsNaturalVoiceAndHidesWhenAbsent() throws {
        let d = JSONDecoder()
        let on = try d.decode(VoiceSettings.self, from: Data(#"{"mode":"gateway","natural":{"installed":true,"enabled":true,"voice":"af_heart"}}"#.utf8))
        #expect(on.natural == NaturalVoice(installed: true, enabled: true, voice: "af_heart"))
        let old = try d.decode(VoiceSettings.self, from: Data(#"{"mode":"gateway"}"#.utf8))
        #expect(old.natural == nil)
    }

    @Test func requestsCarryOnlyWhatChanged() throws {
        func keys(_ data: Data) throws -> [String: Any] {
            let outer = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            return try #require(outer?["natural"] as? [String: Any])
        }
        let toggled = try keys(NaturalVoice.requestBody(enabled: false))
        #expect(toggled.count == 1 && toggled["enabled"] as? Bool == false)
        let picked = try keys(NaturalVoice.requestBody(voice: "am_michael"))
        #expect(picked.count == 1 && picked["voice"] as? String == "am_michael")
    }
}
