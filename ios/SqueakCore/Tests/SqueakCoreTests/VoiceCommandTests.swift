import Foundation
import XCTest
@testable import SqueakCore

/// Pins the `voice` view and command to docs/remote-channel.md, "Phone calls".
final class VoiceCommandTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

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

    private func open(_ change: VoiceChange) throws -> [String: J] {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let ch = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, doc) = try ch.voiceDocument(change, signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        return try ChannelCrypto.open([String: J].self, box: doc.box, key: key)
    }

    func testEnvelopeHasExactlyTheKeysTheMacReads() throws {
        let json = try open(.callee("35210"))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"], .string("voice"))
        XCTAssertEqual(json["v"], .int(1))
    }

    func testEachChangeIsOneKeyWithItsExactType() throws {
        XCTAssertEqual(try open(.callee("35210"))["change"], .object(["callee": .string("35210")]))
        // Clearing is an explicit null, not a missing key.
        XCTAssertEqual(try open(.callee(nil))["change"], .object(["callee": .null]))
        XCTAssertEqual(try open(.test)["change"], .object(["test": .bool(true)]))
        // A pin change: exactly the two pins, nothing else.
        XCTAssertEqual(
            try open(.pin(current: "4821", next: "135790"))["change"],
            .object(["pin": .object(["current": .string("4821"), "next": .string("135790")])]))
    }

    func testPinActionsHaveExactlyTheContractKeys() throws {
        func action(_ a: PinAction) throws -> J { try open(.pinAction(a))["change"]! }
        XCTAssertEqual(try action(.change(current: "4821", next: "135790")),
            .object(["pinAction": .object(["action": .string("change"), "current": .string("4821"), "next": .string("135790")])]))
        XCTAssertEqual(try action(.disable(current: "4821")),
            .object(["pinAction": .object(["action": .string("disable"), "current": .string("4821")])]))
        XCTAssertEqual(try action(.enable(next: "135790")),
            .object(["pinAction": .object(["action": .string("enable"), "next": .string("135790")])]))
        XCTAssertEqual(try action(.reset(next: "135790")),
            .object(["pinAction": .object(["action": .string("reset"), "next": .string("135790")])]))
        // Reset to off is an explicit null, not a missing key.
        XCTAssertEqual(try action(.reset(next: nil)),
            .object(["pinAction": .object(["action": .string("reset"), "next": .null])]))
    }

    func testViewDecodesThePinStateAndToleratesItsAbsence() throws {
        let with = try JSONDecoder().decode(VoiceView.self, from: Data(#"{"mode":"direct","pin":"off"}"#.utf8))
        XCTAssertEqual(with.pin, "off")
        let without = try JSONDecoder().decode(VoiceView.self, from: Data(#"{"mode":"gateway"}"#.utf8))
        XCTAssertNil(without.pin)
    }

    func testAPinIsFourToTwelveDigits() {
        for ok in ["1234", "135790", "123456789012"] { XCTAssertTrue(VoiceFormat.isPin(ok), ok) }
        for bad in ["", "123", "12ab", "1234567890123", "12 34", "+1234"] { XCTAssertFalse(VoiceFormat.isPin(bad), bad) }
    }

    func testViewDecodesWithAndWithoutALastTest() throws {
        let plain = try JSONDecoder().decode(VoiceView.self, from: Data(#"{"mode":"gateway","callee":null,"defaultCallee":null}"#.utf8))
        XCTAssertEqual(plain, VoiceView(mode: "gateway", callee: nil, defaultCallee: nil, lastTest: nil))
        XCTAssertTrue(plain.isOn)
        let tested = try JSONDecoder().decode(
            VoiceView.self,
            from: Data(#"{"mode":"gateway","callee":"35210","defaultCallee":null,"lastTest":{"at":1,"status":"answered","letter":"A"}}"#.utf8))
        XCTAssertEqual(tested.lastTest?.letter, "A")
        XCTAssertFalse(try JSONDecoder().decode(VoiceView.self, from: Data(#"{"mode":"off"}"#.utf8)).isOn)
    }

    func testOnlyAnInternalExtensionIsAnExtension() {
        for ok in ["10", "101", "35210", "123456"] { XCTAssertTrue(VoiceFormat.isExtension(ok), ok) }
        for bad in ["", "1", "1234567", "+919876543210", "10 1", "10a"] { XCTAssertFalse(VoiceFormat.isExtension(bad), bad) }
        XCTAssertNil(VoiceFormat.normalized("   "))
        XCTAssertEqual(VoiceFormat.normalized(" 101 "), "101")
    }

    func testTheTestLineSaysWhatHappened() {
        func line(_ status: String, letter: String? = nil, reason: String? = nil) -> String? {
            VoiceFormat.testLine(.init(at: 0, status: status, letter: letter, reason: reason))
        }
        XCTAssertNil(VoiceFormat.testLine(nil))
        XCTAssertEqual(line("ringing"), "Ringing your phone…")
        XCTAssertEqual(line("answered", letter: "B"), "You answered and pressed B. Nothing was sent anywhere.")
        XCTAssertEqual(line("answered"), "You answered. No key was pressed.")
        XCTAssertEqual(line("unanswered"), "Nobody picked up.")
        XCTAssertEqual(line("failed", reason: "PBX refused"), "The call failed: PBX refused")
    }

    func testPolicyAndPauseHaveExactlyTheContractKeys() throws {
        XCTAssertEqual(try open(.pinAction(.policy(outgoing: .skip, incoming: .ask)))["change"],
            .object(["pinAction": .object(["action": .string("policy"), "incoming": .string("ask"), "outgoing": .string("skip")])]))
        XCTAssertEqual(try open(.pinAction(.policy(outgoing: .ask, incoming: .skip)))["change"],
            .object(["pinAction": .object(["action": .string("policy"), "incoming": .string("skip"), "outgoing": .string("ask")])]))
        for (c, w) in [(PauseChoice.hour, "1h"), (.fourHours, "4h"), (.tomorrow, "tomorrow"), (.forever, "forever"), (.resume, "resume")] {
            XCTAssertEqual(try open(.pause(c))["change"], .object(["pause": .string(w)]))
        }
    }

    func testViewDecodesPolicyAndPauseWithAndWithoutThem() throws {
        func view(_ json: String) throws -> VoiceView { try JSONDecoder().decode(VoiceView.self, from: Data(json.utf8)) }
        let old = try view(#"{"mode":"gateway"}"#)
        XCTAssertNil(old.policy); XCTAssertNil(old.pause)
        let v = try view(#"{"mode":"gateway","policy":{"outgoing":"skip","incoming":"weird"},"pause":null}"#)
        XCTAssertEqual(v.policy, .init(outgoing: .skip, incoming: .ask))
        XCTAssertEqual(v.pause, VoiceView.Pause(active: false))
        XCTAssertEqual(try view(#"{"mode":"gateway","policy":{}}"#).policy, .init(outgoing: .ask, incoming: .ask))
        XCTAssertEqual(try view(#"{"mode":"gateway","pause":{"until":1700000000000}}"#).pause, .init(active: true, until: 1_700_000_000_000))
        XCTAssertEqual(try view(#"{"mode":"gateway","pause":{"until":null}}"#).pause, .init(active: true, until: nil))
    }

    func testPauseLine() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let loc = Locale(identifier: "en_US")
        let now = Date(timeIntervalSince1970: 1_700_000_000) // 22:13 UTC
        func line(_ p: VoiceView.Pause?) -> String { VoiceFormat.pauseLine(p, now: now, calendar: cal, locale: loc).replacingOccurrences(of: "\u{202F}", with: " ") }
        XCTAssertEqual(line(nil), "Calls are on")
        XCTAssertEqual(line(.init(active: false)), "Calls are on")
        XCTAssertEqual(line(.init(active: true, until: nil)), "Paused until you turn it back on")
        XCTAssertEqual(line(.init(active: true, until: (1_700_000_000 + 5_820) * 1000)), "Paused until 11:50 PM")
        XCTAssertEqual(line(.init(active: true, until: (1_700_000_000 - 5) * 1000)), "Calls are on")
        XCTAssertTrue(line(.init(active: true, until: (1_700_000_000 + 86_400) * 1000)).hasPrefix("Paused until Wed"))
    }
}
