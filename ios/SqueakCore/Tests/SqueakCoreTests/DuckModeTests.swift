import Foundation
import XCTest
@testable import SqueakCore

/// Ducks own their branch (flag `ducksOwnBranch`): what the phone groups, words and sends, and what the Mac really writes.
final class DuckModeTests: XCTestCase {
    private let key = Data(repeating: 7, count: 32).base64EncodedString()

    private func duck(_ key: String, duck: String?, branch: String? = nil, main: Bool? = nil, at: String, state: String = "finished", title: String? = nil) -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(
            key: key, conductorSessionId: nil, label: title ?? key, agent: "claude", state: state, lastActivityAt: at,
            detail: nil, git: nil, contextPercent: nil, turnId: nil, message: nil, choices: nil, title: title)
        s.duckId = duck; s.branch = branch; s.onMain = main
        return s
    }

    func testRowsAreDucksNewestFirstWithABranchLabel() {
        let rows = DuckPhone.rows([
            duck("a", duck: "d1", branch: "cart", at: "2026-11-20T10:00:00.000Z", title: "Cart"),
            duck("a2", duck: "d1", branch: "cart", at: "2026-11-21T10:00:00.000Z", title: "Cart again"),
            duck("b", duck: "d2", main: true, at: "2026-11-21T09:00:00.000Z"),
            duck("c", duck: nil, at: "2026-11-19T09:00:00.000Z"),
        ])
        XCTAssertEqual(rows.map(\.id), ["a2", "b", "a", "c"].filter { $0 != "a" })
        XCTAssertEqual(rows.map(\.label), ["cart", "main", nil])
        XCTAssertEqual(DuckPhone.rows([duck("a", duck: "d1", branch: "cart", at: "2026-11-20T10:00:00.000Z")], showsCode: false).map(\.label), [nil])
    }

    func testAHeadOrUnknownBranchIsNotShown() {
        XCTAssertNil(DuckPhone.label(duck("a", duck: "d", branch: "HEAD", at: "2026-11-20T10:00:00.000Z")))
        XCTAssertNil(DuckPhone.branch(duck("a", duck: "d", branch: "master", main: true, at: "2026-11-20T10:00:00.000Z")))
    }

    func testGroupByBranchPutsTheNewestFirstAndUnnamedLast() {
        let rows = DuckPhone.rows([
            duck("a", duck: "d1", branch: "cart", at: "2026-11-20T10:00:00.000Z"),
            duck("b", duck: "d2", branch: "login", at: "2026-11-21T10:00:00.000Z"),
            duck("c", duck: "d3", main: true, at: "2026-11-19T10:00:00.000Z"),
            duck("d", duck: "d4", branch: "cart", at: "2026-11-21T11:00:00.000Z"),
            duck("e", duck: nil, at: "2026-11-22T10:00:00.000Z"),
        ])
        let groups = DuckPhone.groups(rows)
        XCTAssertEqual(groups.map(\.label), ["cart", "login", "main", ""])
        XCTAssertEqual(groups.first?.rows.map(\.id), ["d", "a"])
    }

    func testTheHeaderSaysBranchOrMainReadOnlyAndNeverOnARemotePond() {
        let onBranch = DuckPhone.header(duck("a", duck: "d", branch: "cart", at: "2026-11-20T10:00:00.000Z"), remote: false)
        XCTAssertEqual(onBranch, .init(chip: "cart", readOnly: false, showsPullRequest: true))
        let onMain = DuckPhone.header(duck("a", duck: "d", main: true, at: "2026-11-20T10:00:00.000Z"), remote: false)
        XCTAssertEqual(onMain, .init(chip: "main \u{00B7} read-only", readOnly: true, showsPullRequest: false))
        let remote = DuckPhone.header(duck("a", duck: "d", main: true, at: "2026-11-20T10:00:00.000Z"), remote: true)
        XCTAssertEqual(remote, .init(chip: nil, readOnly: false, showsPullRequest: false))
    }

    func testTheDuckMenuOffersBranchOffWorkWithAndMoveToMain() {
        let all = [
            duck("a", duck: "d1", branch: "cart", at: "2026-11-20T10:00:00.000Z", title: "Cart"),
            duck("b", duck: "d2", branch: "login", at: "2026-11-21T10:00:00.000Z", title: "Login"),
            duck("c", duck: "d3", main: true, at: "2026-11-19T10:00:00.000Z"),
        ]
        let rows = DuckPhone.rows(all)
        let moves = DuckPhone.moves(for: all[0], among: rows, remote: false)
        XCTAssertTrue(moves.branchOff); XCTAssertTrue(moves.moveToMain)
        // Another duck (never main, never itself), then the branches other than its own.
        XCTAssertEqual(moves.joinTargets.map(\.id), ["duck:d2", "branch:login"])
        XCTAssertEqual(moves.joinTargets.first?.place, .join(duckId: "d2"))
        XCTAssertEqual(moves.joinTargets.last?.place, .join(branch: "login"))
        // On main: no "Move to main". Working, remote or no duck: nothing.
        XCTAssertFalse(DuckPhone.moves(for: all[2], among: rows, remote: false).moveToMain)
        XCTAssertEqual(DuckPhone.moves(for: duck("w", duck: "d1", branch: "cart", at: "2026-11-20T10:00:00.000Z", state: "working"), among: rows, remote: false), .none)
        XCTAssertEqual(DuckPhone.moves(for: all[0], among: rows, remote: true), .none)
        XCTAssertEqual(DuckPhone.moves(for: duck("x", duck: nil, at: "2026-11-20T10:00:00.000Z"), among: rows, remote: false), .none)
    }

    func testGroupPrefsToggleAPond() {
        var raw = ""
        XCTAssertFalse(DuckGroupPrefs.contains(raw, pond: "p"))
        raw = DuckGroupPrefs.toggled(raw, pond: "p")
        XCTAssertTrue(DuckGroupPrefs.contains(raw, pond: "p"))
        raw = DuckGroupPrefs.toggled(raw, pond: "p")
        XCTAssertFalse(DuckGroupPrefs.contains(raw, pond: "p"))
    }

    func testTheDuckPlaceCommandCarriesOnlyTheKeysTheMacAccepts() throws {
        let c = Channel(pairing: PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac"), deviceId: "phone-1", transport: FakeTransport())
        let signer = SoftwareSigner()
        func sent(_ place: DuckPlace, _ message: String?) throws -> (Set<String>, PondCommand, [String: AnyCodable]) {
            let (_, doc) = try c.pondDocument(.duckPlace(duckId: "duck-1", place: place, message: message), signer: signer)
            let json = try ChannelCrypto.open([String: AnyCodable].self, box: doc.box, key: key)
            return (Set(json.keys), try ChannelCrypto.open(PondCommand.self, box: doc.box, key: key), json)
        }
        let a = try sent(.main, nil)
        XCTAssertEqual(a.0, ["v", "kind", "op", "duckId", "place", "nonce", "expiresAt"])
        XCTAssertEqual(a.1.op, "duck-place")
        XCTAssertEqual(a.1.place, .main)
        let b = try sent(.new(branch: "try-two"), "  plan it ")
        XCTAssertEqual(b.0, ["v", "kind", "op", "duckId", "place", "message", "nonce", "expiresAt"])
        XCTAssertEqual(b.1.message, "plan it")
        XCTAssertEqual(b.1.place, DuckPlace(kind: "new", branch: "try-two"))
        let place = try JSONEncoder().encode(DuckPlace.join(duckId: "d2"))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: place) as? [String: String], ["kind": "join", "duckId": "d2"])
        XCTAssertThrowsError(try c.pondDocument(.duckPlace(duckId: "", place: .main, message: nil), signer: signer))
    }

    func testDecodesWhatTheMacActuallyWritesWithTheFlagOn() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mac-made", withExtension: "json", subdirectory: "Fixtures"))
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let payload = try PairingPayload.parse(raw["pairingURL"] as! String)
        // Flag off (the ordinary view): nothing of it.
        let off = try ChannelCrypto.open(PhoneSnapshot.self, box: raw["snapshotBox"] as! String, key: payload.k)
        XCTAssertFalse(DuckPhone.enabled(off))
        XCTAssertNil(off.ponds?.first { $0.id == "p-shop" }?.branches)
        XCTAssertNil(off.sessions.first?.duckId)
        // Flag on.
        let on = try ChannelCrypto.open(PhoneSnapshot.self, box: raw["ducksSnapshotBox"] as! String, key: payload.k)
        XCTAssertTrue(DuckPhone.enabled(on))
        let shop = try XCTUnwrap(on.ponds?.first { $0.id == "p-shop" })
        XCTAssertEqual(shop.branches?.map(\.name), ["arm"])
        XCTAssertEqual(shop.branches?.first?.ducks, 2)
        XCTAssertNotNil(shop.streams, "streams stay for an older phone")
        let dk1 = try XCTUnwrap((on.sessions + (on.recent ?? [])).first { $0.key == "squeak-native:dk1" })
        XCTAssertEqual(dk1.duckId, "duck-1"); XCTAssertEqual(dk1.branch, "arm"); XCTAssertNil(dk1.onMain)
        let dk3 = try XCTUnwrap((on.sessions + (on.recent ?? [])).first { $0.key == "squeak-native:dk3" })
        XCTAssertEqual(dk3.onMain, true); XCTAssertNil(dk3.branch)
        XCTAssertEqual(DuckPhone.header(dk3, remote: false).chip, "main \u{00B7} read-only")
        // The pond's thread list, rows carry the duck and where it works.
        let doc = try ChannelCrypto.open(PondThreads.self, box: raw["ducksPondThreadsBox"] as! String, key: payload.k)
        let threads = doc.threads
        XCTAssertEqual(threads.first { $0.key == "squeak-native:dk1" }?.branch, "arm")
        XCTAssertEqual(threads.first { $0.key == "squeak-native:dk3" }?.main, true)
        XCTAssertEqual(threads.first { $0.key == "squeak-native:dk2" }?.duckId, "duck-2")
        XCTAssertEqual(threads.first { $0.key == "squeak-native:dk1" }?.asSession.branch, "arm")
    }
}
