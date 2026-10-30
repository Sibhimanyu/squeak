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
        XCTAssertEqual(
            VoiceFormat.testLine(.init(at: 0, status: "answered", letter: "B", quality: .init(verdict: "fair", jitterMs: 40))),
            "You answered and pressed B. Nothing was sent anywhere. Line quality: fair.")
        let decoded = try? JSONDecoder().decode(VoiceView.LastTest.self, from: Data(#"{"at":1,"status":"answered","quality":{"verdict":"poor","lossPct":7.5}}"#.utf8))
        XCTAssertEqual(decoded?.quality?.verdict, "poor")
        XCTAssertNil(try? JSONDecoder().decode(VoiceView.LastTest.self, from: Data(#"{"at":1,"status":"answered"}"#.utf8)).quality)
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

/// The voice parity fields (realistic voice, Quick workspaces, call history) and their commands.
final class VoiceParityTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func view(_ json: String) throws -> VoiceView { try JSONDecoder().decode(VoiceView.self, from: Data(json.utf8)) }

    private struct AnyJSON: Decodable {
        let value: Any
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { value = NSNull() }
            else if let v = try? c.decode(Bool.self) { value = v }
            else if let v = try? c.decode(Int64.self) { value = v }
            else if let v = try? c.decode(Double.self) { value = v }
            else if let v = try? c.decode(String.self) { value = v }
            else if let v = try? c.decode([AnyJSON].self) { value = v.map(\.value) }
            else { value = (try c.decode([String: AnyJSON].self)).mapValues(\.value) }
        }
    }

    /// The signed envelope's `change`, as sorted-key JSON; also checks the envelope's own five keys.
    private func change(_ change: VoiceChange) throws -> String {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let ch = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, doc) = try ch.voiceDocument(change, signer: SoftwareSigner())
        let root = try ChannelCrypto.open(AnyJSON.self, box: doc.box, key: key).value as! [String: Any]
        XCTAssertEqual(Set(root.keys), ["v", "kind", "change", "nonce", "expiresAt"])
        return String(data: try JSONSerialization.data(withJSONObject: root["change"]!, options: [.sortedKeys, .fragmentsAllowed]), encoding: .utf8)!
    }

    func testOlderMacDecodesWithoutTheNewFields() throws {
        let v = try view(#"{"mode":"gateway","callee":"1","defaultCallee":null}"#)
        XCTAssertNil(v.natural); XCTAssertNil(v.favorites); XCTAssertNil(v.workspaces); XCTAssertNil(v.calls)
        // natural without `voices` (a Mac before the picker) is not offered.
        let n = try view(#"{"mode":"direct","natural":{"installed":true,"enabled":false,"voice":"af_heart"}}"#)
        XCTAssertEqual(n.natural?.offered, false)
    }

    func testDecodesTheDocumentedView() throws {
        let v = try view("""
        {"mode":"gateway","natural":{"installed":true,"enabled":true,"voice":"af_heart","voices":[{"id":"af_heart","label":"Heart (female)"},{"id":"am_adam","label":"Adam (male)"}]},
         "favorites":[{"n":1,"workspace":"ws1","label":"squeak · main"}],
         "workspaces":[{"key":"ws1","label":"squeak · main"},{"key":"ws2","label":"blume"}],
         "calls":[{"id":"a","at":1761800000000,"kind":"agent","reason":"blocked_question","label":"squeak · main","outcome":"answered","letter":"B","sent":true,"durationMs":42000,
                   "events":[{"at":1761800001000,"source":"add-on","kind":"heard","text":"B"},{"at":1,"source":"x","kind":"y","text":"odd"}]},
                  {"id":"b","at":2,"kind":"zzz","outcome":"failed","failure":"no route","durationMs":0}]}
        """)
        XCTAssertEqual(v.natural?.offered, true)
        XCTAssertEqual(v.natural?.voices?.map(\.id), ["af_heart", "am_adam"])
        XCTAssertEqual(v.favorites, [FavoriteWorkspace(n: 1, workspace: "ws1", label: "squeak · main")])
        XCTAssertEqual(v.workspaces?.count, 2)
        XCTAssertEqual(v.calls?.count, 2)
        XCTAssertEqual(v.calls?[0].events[0].source, .addOn)
        XCTAssertEqual(v.calls?[0].events[0].kind, .heard)
        // Unknown words fall back, never fail the view.
        XCTAssertEqual(v.calls?[0].events[1].source, .mac)
        XCTAssertEqual(v.calls?[0].events[1].kind, .step)
        XCTAssertEqual(v.calls?[1].kind, .agent)
        XCTAssertEqual(CallText.outcomeSentence(v.calls![1]), "Could not be placed: no route")
        XCTAssertEqual(CallText.outcomeSentence(v.calls![0]), "Answered, pressed B \u{00B7} sent")
    }

    func testNaturalAndFavoritesCommandsAreOneKeyWithExactShape() throws {
        XCTAssertEqual(try change(.natural(enabled: false, voice: nil)), #"{"natural":{"enabled":false}}"#)
        XCTAssertEqual(try change(.natural(enabled: nil, voice: "am_adam")), #"{"natural":{"voice":"am_adam"}}"#)
        XCTAssertEqual(try change(.natural(enabled: true, voice: "bf_emma")), #"{"natural":{"enabled":true,"voice":"bf_emma"}}"#)
        // Favourites carry n and workspace only: never the label.
        XCTAssertEqual(
            try change(.favorites([FavoriteWorkspace(n: 1, workspace: "ws1", label: "squeak"), FavoriteWorkspace(n: 3, workspace: "ws3", label: "x")])),
            #"{"favorites":[{"n":1,"workspace":"ws1"},{"n":3,"workspace":"ws3"}]}"#)
        XCTAssertEqual(try change(.favorites([])), #"{"favorites":[]}"#)
    }

    func testQuickWorkspaceRules() {
        let offered = [WorkspaceChoice(key: "a", label: "A"), WorkspaceChoice(key: "b", label: "B")]
        let one = QuickWorkspaces.added([], candidates: offered)!
        XCTAssertEqual(one, [FavoriteWorkspace(n: 1, workspace: "a", label: "A")])
        let two = QuickWorkspaces.added(one, candidates: offered)!
        XCTAssertEqual(two.map(\.n), [1, 2])
        XCTAssertNil(QuickWorkspaces.added(two, candidates: offered), "no candidate left")
        XCTAssertNil(QuickWorkspaces.renumbered(two, from: 1, to: 2), "digit held by another row")
        XCTAssertNil(QuickWorkspaces.renumbered(two, from: 1, to: 10))
        XCTAssertEqual(QuickWorkspaces.renumbered(two, from: 2, to: 5)?.map(\.n), [1, 5])
        XCTAssertEqual(QuickWorkspaces.availableNumbers(for: 1, in: two), [1, 3, 4, 5, 6, 7, 8, 9])
        XCTAssertEqual(QuickWorkspaces.removed(two, n: 1).map(\.n), [2])
        XCTAssertTrue(QuickWorkspaces.isValid(two, offered: offered, saved: []))
        XCTAssertFalse(QuickWorkspaces.isValid([FavoriteWorkspace(n: 1, workspace: "a"), FavoriteWorkspace(n: 1, workspace: "b")], offered: offered, saved: []))
        XCTAssertFalse(QuickWorkspaces.isValid([FavoriteWorkspace(n: 0, workspace: "a")], offered: offered, saved: []))
        XCTAssertFalse(QuickWorkspaces.isValid([FavoriteWorkspace(n: 1, workspace: "zzz")], offered: offered, saved: []), "unknown workspace")
        XCTAssertTrue(QuickWorkspaces.isValid([FavoriteWorkspace(n: 1, workspace: "zzz")], offered: offered, saved: [FavoriteWorkspace(n: 4, workspace: "zzz")]), "already saved")
        XCTAssertFalse(QuickWorkspaces.isValid([FavoriteWorkspace(n: 1, workspace: String(repeating: "x", count: 201))], offered: [WorkspaceChoice(key: String(repeating: "x", count: 201), label: "")], saved: []))
    }

    func testCallsCapabilityIsOnlyAnnouncedWhileOpen() async throws {
        XCTAssertFalse(ChannelCrypto.capabilities.contains("calls"))
        XCTAssertEqual(ChannelCrypto.callsCapability, "calls")
        XCTAssertLessThanOrEqual(ChannelCrypto.callsCapability.count, 20)
        XCTAssertLessThanOrEqual(ChannelCrypto.capabilities.count + 1, 10)
    }

    func testCallTextWords() {
        let e = CallEntry(id: "x", at: 0, kind: .incoming, label: "squeak", outcome: .answered, sent: true, durationMs: 72000)
        XCTAssertEqual(CallText.what(e), "You called Squeak \u{00B7} squeak")
        XCTAssertEqual(CallText.duration(ms: 72000), "1 min 12 s")
        XCTAssertEqual(CallText.eventBody(CallEvent(at: 0, kind: .said, text: "Hi")), "\u{201C}Hi\u{201D}")
    }
}

/// The `voiceSample` command: exactly five keys, and the view flag that offers it.
final class VoiceSampleCommandTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    private struct KeySet: Decodable {
        let names: Set<String>
        init(from decoder: Decoder) throws {
            names = Set(try decoder.container(keyedBy: AnyKey.self).allKeys.map(\.stringValue))
        }
    }
    private struct Fields: Decodable { let v: Int; let kind: String; let voice: String }

    func testEnvelopeHasExactlyTheKeysTheMacReads() throws {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let ch = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, doc) = try ch.voiceSampleDocument(voice: "am_adam", signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        let keys = try ChannelCrypto.open(KeySet.self, box: doc.box, key: key)
        XCTAssertEqual(keys.names, ["v", "kind", "voice", "nonce", "expiresAt"])
        let fields = try ChannelCrypto.open(Fields.self, box: doc.box, key: key)
        XCTAssertEqual(fields.v, 1)
        XCTAssertEqual(fields.kind, "voiceSample")
        XCTAssertEqual(fields.voice, "am_adam")
    }

    func testSampleFlagDecodesAndOlderMacOmitsIt() throws {
        let on = try JSONDecoder().decode(VoiceView.self, from: Data(#"{"mode":"gateway","natural":{"installed":true,"enabled":true,"voice":"af_heart","voices":[{"id":"af_heart","label":"Heart"}],"sample":true}}"#.utf8))
        XCTAssertEqual(on.natural?.sample, true)
        let old = try JSONDecoder().decode(VoiceView.self, from: Data(#"{"mode":"gateway","natural":{"installed":true,"enabled":true,"voice":"af_heart","voices":[{"id":"af_heart","label":"Heart"}]}}"#.utf8))
        XCTAssertNil(old.natural?.sample)
    }
}
