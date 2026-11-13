import Foundation
import XCTest
@testable import SqueakCore

final class PondsTwoTests: XCTestCase {
    let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func channel() -> Channel {
        Channel(pairing: PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac"), deviceId: "phone-1", transport: FakeTransport())
    }

    private func snapshot(adding extra: [String: Any]) throws -> PhoneSnapshot {
        let base = try JSONEncoder().encode(PhoneSnapshot(v: 1, mac: "m", generatedAt: "", duck: .init(blockedCount: 0, workingCount: 0), sessions: [], recent: []))
        var obj = try JSONSerialization.jsonObject(with: base) as! [String: Any]
        for (k, v) in extra { obj[k] = v }
        return try JSONDecoder().decode(PhoneSnapshot.self, from: JSONSerialization.data(withJSONObject: obj))
    }

    func testDecodesEveryNewPondFieldAndAnOlderMacWithoutThem() throws {
        let old = try snapshot(adding: ["ponds": [["id": "a", "name": "Shop", "shared": false, "members": []]]])
        let p = try XCTUnwrap(old.ponds?.first)
        XCTAssertNil(p.projectId); XCTAssertNil(p.hidden); XCTAssertNil(p.streams); XCTAssertNil(old.pondOrder); XCTAssertNil(old.pondDetail)
        XCTAssertEqual(p.orderKey, "a")
        XCTAssertFalse(p.isHidden)

        let new = try snapshot(adding: [
            "ponds": [["id": "a", "name": "Shop", "shared": true, "members": [], "projectId": "proj", "hidden": true, "colour": "teal",
                       "labels": ["web"], "lastActivityAt": "2026-09-25T03:00:00.000Z",
                       "streams": [["id": "w1", "name": "Arm", "branch": "arm", "pinned": true, "lastActivityAt": "2026-09-25T03:00:00.000Z"],
                                   ["id": "w2", "name": "Old", "archived": true]],
                       "archivedStreams": 2]],
            "pondOrder": ["mode": "manual", "ids": ["proj"]],
            "pondDetail": ["id": "a", "invites": [["label": "editor invite", "expiresAt": "2026-09-26T03:00:00.000Z"]],
                           "waiting": [["name": "Ravi"]], "ripples": [["text": "started", "at": "2026-09-25T02:00:00.000Z", "who": "Asha"]]],
        ])
        let pond = try XCTUnwrap(new.ponds?.first)
        XCTAssertEqual(pond.orderKey, "proj")
        XCTAssertTrue(pond.isHidden)
        XCTAssertEqual(pond.colour, "teal")
        XCTAssertEqual(pond.labels, ["web"])
        XCTAssertEqual(pond.streams?.map(\.id), ["w1", "w2"])
        XCTAssertEqual(pond.streams?.first?.pinned, true)
        XCTAssertEqual(pond.streams?.last?.archived, true)
        XCTAssertEqual(pond.archivedStreams, 2)
        XCTAssertEqual(new.pondOrder, .init(mode: "manual", ids: ["proj"]))
        XCTAssertTrue(try XCTUnwrap(new.pondOrder).isManual)
        XCTAssertEqual(new.pondDetail?.waiting, [.init(name: "Ravi")])
        XCTAssertEqual(new.pondDetail?.ripples?.first?.who, "Asha")
        XCTAssertEqual(new.pondDetail?.invites?.first?.label, "editor invite")
    }

    func testDecodesWhatTheMacActuallySends() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mac-made", withExtension: "json", subdirectory: "Fixtures"))
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let payload = try PairingPayload.parse(raw["pairingURL"] as! String)
        let snap = try ChannelCrypto.open(PhoneSnapshot.self, box: raw["snapshotBox"] as! String, key: payload.k)
        let shop = try XCTUnwrap(snap.ponds?.first { $0.id == "p-shop" })
        XCTAssertEqual(shop.projectId, "p1")
        XCTAssertEqual(shop.colour, "teal")
        XCTAssertEqual(shop.streams?.count, 2)
        XCTAssertEqual(shop.archivedStreams, 2)
        let docs = try XCTUnwrap(snap.ponds?.first { $0.id == "p-docs" })
        XCTAssertTrue(docs.isHidden)
        XCTAssertEqual(snap.pondOrder, .init(mode: "manual", ids: ["proj-docs", "p1"]))
        XCTAssertEqual(snap.pondDetail?.id, "p-shop")
        XCTAssertEqual(snap.pondDetail?.waiting?.first?.name, "Ravi")
    }

    func testPondCommandsCarryOnlyTheKeysTheMacAccepts() throws {
        let c = channel()
        let signer = SoftwareSigner()
        func keys(_ change: Channel.PondChange) throws -> (Set<String>, PondCommand) {
            let (_, doc) = try c.pondDocument(change, signer: signer)
            XCTAssertEqual(doc.device, "phone-1"); XCTAssertNotNil(doc.sig)
            let json = try ChannelCrypto.open([String: AnyCodable].self, box: doc.box, key: key)
            return (Set(json.keys), try ChannelCrypto.open(PondCommand.self, box: doc.box, key: key))
        }
        let hide = try keys(.hide(pondId: "a", hidden: true))
        XCTAssertEqual(hide.0, ["v", "kind", "op", "pondId", "hidden", "nonce", "expiresAt"])
        XCTAssertEqual(hide.1.op, "hide")
        let order = try keys(.orderManual(ids: ["x", "y"]))
        XCTAssertEqual(order.0, ["v", "kind", "op", "ids", "nonce", "expiresAt"])
        XCTAssertEqual(order.1.ids, ["x", "y"])
        let newest = try keys(.orderNewest)
        XCTAssertEqual(newest.0, ["v", "kind", "op", "mode", "nonce", "expiresAt"])
        XCTAssertEqual(newest.1.mode, "newest")
        XCTAssertEqual(hide.1.kind, "pond")
        XCTAssertThrowsError(try c.pondDocument(.orderManual(ids: Array(repeating: "k", count: 201)), signer: signer))
    }

    func testPresenceCarriesTheOpenPondAndPonds2() throws {
        XCTAssertTrue(ChannelCrypto.capabilities.contains("ponds2"))
        XCTAssertLessThanOrEqual(ChannelCrypto.capabilities.count + 1, 10)
        let box = try ChannelCrypto.seal(Presence(at: 1, caps: ChannelCrypto.capabilities, pond: "p-shop"), key: key)
        XCTAssertEqual(try ChannelCrypto.open(Presence.self, box: box, key: key).pond, "p-shop")
        let none = try ChannelCrypto.seal(Presence(at: 1), key: key)
        let json = try ChannelCrypto.open([String: AnyCodable].self, box: none, key: key)
        XCTAssertNil(json["pond"])
    }
}
