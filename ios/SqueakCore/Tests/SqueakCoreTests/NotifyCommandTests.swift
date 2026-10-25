import Foundation
import XCTest
@testable import SqueakCore

/// Pins the `notify` view and command to docs/remote-channel.md, "Notification settings".
final class NotifyCommandTests: XCTestCase {
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

    private func open(_ channel: String, _ change: NotifyChange) throws -> [String: J] {
        let pairing = PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac")
        let ch = Channel(pairing: pairing, deviceId: "phone-1", transport: FakeTransport())
        let (_, doc) = try ch.notifyDocument(channel: channel, change, signer: SoftwareSigner())
        XCTAssertNotNil(doc.sig)
        return try ChannelCrypto.open([String: J].self, box: doc.box, key: key)
    }

    func testEnvelopeHasExactlyTheKeysTheMacReads() throws {
        let json = try open("cliq", .finished("off"))
        XCTAssertEqual(Set(json.keys), ["v", "kind", "channel", "change", "nonce", "expiresAt"])
        XCTAssertEqual(json["kind"], .string("notify"))
        XCTAssertEqual(json["channel"], .string("cliq"))
        XCTAssertEqual(json["v"], .int(1))
        XCTAssertEqual(json["change"], .object(["finished": .string("off")]))
    }

    func testEveryChangeIsOneKeyWithItsExactType() throws {
        let cases: [(NotifyChange, String, J)] = [
            (.muted(true), "muted", .bool(true)), (.approval(false), "approval", .bool(false)),
            (.question(true), "question", .bool(true)), (.stalled(false), "stalled", .bool(false)),
            (.quota(true), "quota", .bool(true)), (.finished("all"), "finished", .string("all")),
            (.quiet(.init(from: "22:00", to: "07:00")), "quiet", .object(["from": .string("22:00"), "to": .string("07:00")])),
            (.quiet(nil), "quiet", .null),
        ]
        for (change, name, value) in cases {
            let json = try open("telegram", change)
            guard case .object(let body) = json["change"] else { return XCTFail("no change") }
            XCTAssertEqual(body, [name: value], name)
        }
    }

    func testDecodesTheDocumentedView() throws {
        let text = """
        {"telegram":{"muted":false,"approval":true,"question":true,"stalled":true,"quota":true,"finished":"conductor","quiet":null},
         "cliq":{"muted":true,"approval":true,"question":false,"stalled":true,"quota":true,"finished":"all","quiet":{"from":"22:00","to":"07:00"}},
         "channels":{"telegram":true,"cliq":false}}
        """
        let notify = try JSONDecoder().decode(NotifySettings.self, from: Data(text.utf8))
        XCTAssertEqual(notify.telegram, NotifySettings.ChannelSettings())
        XCTAssertEqual(notify.cliq?.quiet, .init(from: "22:00", to: "07:00"))
        XCTAssertEqual(notify.cliq?.finished, "all")
        XCTAssertEqual(notify.cliq?.muted, true)
        XCTAssertTrue(notify.configured("telegram"))
        XCTAssertFalse(notify.configured("cliq"))
    }

    func testAnOlderOrSparserMacStillDecodes() throws {
        let sparse = try JSONDecoder().decode(NotifySettings.self, from: Data(#"{"telegram":{"muted":true}}"#.utf8))
        XCTAssertEqual(sparse.telegram?.muted, true)
        XCTAssertEqual(sparse.telegram?.approval, true)
        XCTAssertEqual(sparse.telegram?.finished, "conductor")
        XCTAssertNil(sparse.cliq)
        XCTAssertTrue(sparse.configured("cliq"))
    }

    func testChangeAppliesAndQuietClearsToNil() {
        var s = NotifySettings.ChannelSettings(quiet: NotifyFormat.defaultQuiet)
        NotifyChange.quiet(nil).apply(to: &s)
        XCTAssertNil(s.quiet)
        NotifyChange.finished("off").apply(to: &s)
        NotifyChange.muted(true).apply(to: &s)
        XCTAssertEqual(s.finished, "off")
        XCTAssertTrue(s.muted)
    }

    func testQuietHoursFormatting() {
        XCTAssertEqual(NotifyFormat.quietSummary(.init(from: "22:00", to: "07:00")), "22:00 to 07:00")
        XCTAssertEqual(NotifyFormat.quietSummary(nil), "Off")
        XCTAssertEqual(NotifyFormat.minutes("07:05"), 425)
        XCTAssertNil(NotifyFormat.minutes("7:05"))
        XCTAssertNil(NotifyFormat.minutes("24:00"))
        XCTAssertNil(NotifyFormat.minutes("12:60"))
        XCTAssertEqual(NotifyFormat.clock(minutes: 425), "07:05")
        XCTAssertEqual(NotifyFormat.clock(minutes: -60), "23:00")
        XCTAssertTrue(NotifyFormat.isValid(.init(from: "22:00", to: "07:00")))
        XCTAssertFalse(NotifyFormat.isValid(.init(from: "08:00", to: "08:00")))
        XCTAssertFalse(NotifyFormat.isValid(.init(from: "8:00", to: "09:00")))
        XCTAssertTrue(NotifyFormat.crossesMidnight(.init(from: "22:00", to: "07:00")))
        XCTAssertFalse(NotifyFormat.crossesMidnight(.init(from: "09:00", to: "17:00")))
        XCTAssertTrue(NotifyFormat.quietFootnote.contains("approval"))
    }
}
