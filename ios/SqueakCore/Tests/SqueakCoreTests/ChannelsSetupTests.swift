import Foundation
import XCTest
@testable import SqueakCore

/// Pins the `telegram` / `cliq` commands and the `channelsSetup` view to .context/channels-setup-protocol.md.
final class ChannelsSetupTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()
    let fakeToken = "123456789:FAKE_unit-test_TokenAbcdefghij"
    let fakeWebhook = "https://cliq.zoho.in/api/v2/bots/x/incoming?zapikey=FAKE-unit-test-key"

    private func channel() -> Channel {
        Channel(pairing: PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac"), deviceId: "phone-1", transport: FakeTransport())
    }

    private func opened(_ doc: ChannelDocument) throws -> [String: Any] {
        let plain = try ChannelCrypto.open(AnyJSON.self, box: doc.box, key: key)
        return plain.value as! [String: Any]
    }

    /// Reads any JSON, integers staying integers.
    private struct AnyJSON: Decodable {
        let value: Any
        init(from decoder: Decoder) throws {
            if let c = try? decoder.container(keyedBy: K.self) {
                var out: [String: Any] = [:]
                for k in c.allKeys { out[k.stringValue] = try c.decode(AnyJSON.self, forKey: k).value }
                value = out
            } else if let s = try? decoder.singleValueContainer() {
                if s.decodeNil() { value = NSNull() }
                else if let b = try? s.decode(Bool.self) { value = b }
                else if let i = try? s.decode(Int64.self) { value = i }
                else { value = try s.decode(String.self) }
            } else { value = NSNull() }
        }
        struct K: CodingKey {
            var stringValue: String; var intValue: Int? { nil }
            init?(stringValue: String) { self.stringValue = stringValue }
            init?(intValue: Int) { nil }
        }
    }

    private func change(_ c: TelegramChange) throws -> ([String: Any], [String: Any]) {
        let (_, doc) = try channel().telegramDocument(change: c, signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        let json = try opened(doc)
        return (json, json["change"] as! [String: Any])
    }

    func testTelegramEnvelopeAndChanges() throws {
        let (json, ch) = try change(.token(fakeToken))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"] as? String, "telegram")
        XCTAssertEqual(json["v"] as? Int64, 1)
        XCTAssertEqual(ch as NSDictionary, ["token": fakeToken] as NSDictionary)
        for (c, k) in [(TelegramChange.off, "off"), (.startLink, "startLink"), (.stopLink, "stopLink"), (.test, "test")] {
            let (_, one) = try change(c)
            XCTAssertEqual(Set(one.keys), [k]); XCTAssertEqual(one[k] as? Bool, true)
        }
        let (_, link) = try change(.link(-1001234567890))
        XCTAssertEqual(link["link"] as? Int64, -1001234567890)
        let (_, unlink) = try change(.unlink(987654321))
        XCTAssertEqual(unlink["unlink"] as? Int64, 987654321)
    }

    func testCliqEnvelopeAndChanges() throws {
        func go(_ c: CliqChange) throws -> ([String: Any], [String: Any]) {
            let (_, doc) = try channel().cliqDocument(change: c, signer: SoftwareSigner())
            let json = try opened(doc)
            return (json, json["change"] as! [String: Any])
        }
        let (json, hook) = try go(.webhook(fakeWebhook))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"] as? String, "cliq")
        XCTAssertEqual(hook as NSDictionary, ["webhook": fakeWebhook] as NSDictionary)
        let (_, rm) = try go(.removeWebhook)
        XCTAssertEqual(rm as NSDictionary, ["removeWebhook": true] as NSDictionary)
        let (_, owner) = try go(.owner(email: "a@b.co", id: nil))
        let inner = owner["owner"] as! [String: Any]
        XCTAssertEqual(Set(inner.keys), ["email", "id"])
        XCTAssertEqual(inner["email"] as? String, "a@b.co")
        XCTAssertTrue(inner["id"] is NSNull)
    }

    func testOwnerCheckRules() {
        XCTAssertFalse(TelegramChange.test.requiresOwnerCheck)
        XCTAssertFalse(TelegramChange.startLink.requiresOwnerCheck)
        XCTAssertFalse(TelegramChange.stopLink.requiresOwnerCheck)
        for c in [TelegramChange.token("x"), .off, .link(1), .unlink(1)] { XCTAssertTrue(c.requiresOwnerCheck) }
        for c in [CliqChange.webhook("x"), .removeWebhook, .owner(email: nil, id: nil)] { XCTAssertTrue(c.requiresOwnerCheck) }
    }

    func testViewDecodesWithAndWithoutTheField() throws {
        let base = try JSONEncoder().encode(PhoneSnapshot(v: 1, mac: "m", generatedAt: "", duck: .init(blockedCount: 0, workingCount: 0), sessions: [], recent: []))
        var obj = try JSONSerialization.jsonObject(with: base) as! [String: Any]
        obj.removeValue(forKey: "channelsSetup")
        XCTAssertNil(try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj)).channelsSetup)
        obj["channelsSetup"] = [
            "telegram": [
                "tokenSet": true, "bot": "squeak_bot", "polling": "ok", "lastError": NSNull(),
                "chats": [["id": -1001234567890, "name": NSNull()], ["id": 5, "name": "Me"], ["name": "no id"]],
                "open": false,
                "linking": ["until": "2026-10-30T10:00:00Z", "candidates": [["id": 7, "name": "Pat", "type": "private"], ["bad": 1]]],
                "testing": false,
                "lastTest": ["at": "2026-10-30T10:00:00Z", "ok": false, "sentTo": 0, "reason": "Telegram refused"],
                "futureField": 1,
            ],
            "cliq": ["webhookSet": true, "ownerEmail": "a@b.co", "ownerId": NSNull(), "oneWay": true, "twoWay": false],
            "restarting": false,
        ]
        let with = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj)).channelsSetup
        let t = try XCTUnwrap(with?.telegram)
        XCTAssertEqual(t.chats?.map(\.id), [-1001234567890, 5])
        XCTAssertEqual(t.linking?.candidates.map(\.id), [7])
        XCTAssertEqual(t.lastTest?.reason, "Telegram refused")
        XCTAssertEqual(with?.cliq?.ownerEmail, "a@b.co")
        // A wrong type loses that field, not the view.
        obj["channelsSetup"] = ["telegram": ["tokenSet": "yes", "bot": "b"], "cliq": 3]
        let odd = try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj)).channelsSetup
        XCTAssertNil(odd?.telegram?.tokenSet); XCTAssertEqual(odd?.telegram?.bot, "b"); XCTAssertNil(odd?.cliq)
    }

    func testValidation() {
        XCTAssertTrue(ChannelsSetupFormat.isBotToken(fakeToken))
        XCTAssertFalse(ChannelsSetupFormat.isBotToken("nope"))
        XCTAssertFalse(ChannelsSetupFormat.isBotToken("123:short"))
        XCTAssertTrue(ChannelsSetupFormat.isCliqWebhook(fakeWebhook))
        XCTAssertFalse(ChannelsSetupFormat.isCliqWebhook("http://cliq.zoho.in/x"))
        XCTAssertFalse(ChannelsSetupFormat.isCliqWebhook("https://example.com/x"))
    }

    func testNoSecretEverAppearsInWhatTheCodePrints() throws {
        let t = TelegramChange.token(fakeToken), c = CliqChange.webhook(fakeWebhook)
        let (_, tdoc) = try channel().telegramDocument(change: t, signer: SoftwareSigner())
        let (_, cdoc) = try channel().cliqDocument(change: c, signer: SoftwareSigner())
        var strings = ["\(t)", String(reflecting: t), t.description, t.ownerReason, "\(c)", String(reflecting: c), c.description, c.ownerReason,
                       tdoc.box, cdoc.box]
        let tcmd = TelegramSetupCommand(v: 1, kind: "telegram", change: t, nonce: "n", expiresAt: 1)
        strings += ["\(tcmd)", String(describing: tcmd)]
        let ok = try JSONDecoder().decode(CommandResult.self, from: Data(#"{"id":"a","status":"sent"}"#.utf8))
        strings += [ChannelsSetupFormat.refusal(for: ok) ?? "", ChannelsSetupFormat.badToken, ChannelsSetupFormat.badWebhook, ChannelsSetupFormat.restartNote]
        for s in strings {
            XCTAssertFalse(s.contains("FAKE"), s)
            XCTAssertFalse(s.contains("zapikey"), s)
        }
    }

    func testWording() {
        XCTAssertEqual(ChannelsSetupFormat.turnOffTitle, "Turn off Telegram?")
        XCTAssertEqual(ChannelsSetupFormat.restartNote, "Saving restarts the Squeak service for a few seconds.")
        let t = ChannelsSetup.Telegram(tokenSet: true, bot: "b_bot", polling: "ok")
        XCTAssertEqual(ChannelsSetupFormat.telegramStatus(t, restarting: false).text, "Connected as @b_bot")
        XCTAssertEqual(ChannelsSetupFormat.telegramStatus(.init(), restarting: false).text, "Telegram is not set up")
        XCTAssertEqual(ChannelsSetupFormat.linkSteps(bot: "b_bot")[0], "1. Open Telegram and send any message to @b_bot.")
    }
}
