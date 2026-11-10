import CryptoKit
import Foundation
import XCTest
@testable import SqueakCore

final class AccountTests: XCTestCase {
    // src/flotilla/fixtures/web-vectors.json "ecies": made by the Mac's sealToMember.
    let vectorPrivate = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQge4/KgeysBkPkfsaodSnTkQ1gjAXFi4ALnWRma0hVQdGhRANCAAS7NA+1rCmLldd57dfLvVG2LtbdFUjH2AnDT4nksP9pQcGNH9JdG9kgDYHdGaNi8KkN0S+LCWobwhnTHjm6wud3"
    let vectorBox = "BMiIxv9fFRqE+5TZotzkgmZFwVVVbWg6eqe0q8tUXHHojTY7v9PuL7/8Yyi1js+90GpMDp36TGHlF/wG8op8p51nhe5cKBGZjlwN1lQb0IASN3C0UHxbhnWOQI3fHegHkQGwT+mk2IsCGQPOrjuXIviQRbKGfL89rs8G7sQrcy0qaGJuBfyzzTU6jWmqaUDkAhR2TrcS3c641JXO68Jr"
    // A Catalyst pairing payload sealed by sealToMember (generated with src/flotilla/crypto.ts for this test).
    let pairPrivate = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgyqYam5IMg+w229ZTpY/fX1pdYNPE9sCCEhLVpuNzdTehRANCAAQzXyYpVNREVlNmjzTWHIumsnp9YUHbUEm0HDAVB7KwtjXQmtt539HS09aGyFj3/C0ix7EICGNnB0uWo2N5GiEm"
    let pairBox = "BPQigNZ4fQvF5DGIhXpbWm6tIWdRTBdNe5FS58zQrX7GySzcvn8dUHJdH3oV0RI8KzLkWQ7tDYy14PCy3cTfawj4imjRO6Jl3dxnwgiuEUrfZ13ATIuA7jAdHmuBA65m9otMhsbsL0mTZtskgHNPyCIakTLaO5RRjtyYU85Yqnur3CD6DI5afv5MGfOqghOqV/G1p1i3Ymo2U+rfEXUYdmM+sXy3rdVKu2gfQSwq2BdCGh/3kwHk4YJA+vd6XP5oW+aPbrbv2qHhRu+h2M1rvWmCYaXa3miWs+iqRDcrLpXRrJaIxF+86K/ai+lFDdqQuUx4MKOfCYGh2jjn+eFKtT8NPhwFBuHQCDSFjKjGDJcgFVRdIFi0chesN/K4IsoweTkNlWqBIgaw5WZqZ+a3jA0LyV7xiTrKU3CJF1fqSQH20q00+TvEkeNN3QA1kA=="

    func key(_ der: String) throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(derRepresentation: Data(base64Encoded: der)!)
    }

    func testOpensTheMacsVector() throws {
        let plain = try MemberBox.open(vectorBox, with: key(vectorPrivate))
        XCTAssertEqual(String(decoding: plain, as: UTF8.self), #"{"version":2,"key":"sdh6IPK/dxdVdBHmbBej52KmN5f/n7IpSxblv5QHThc="}"#)
    }

    func testRejectsTamperedAndWrongKey() throws {
        var raw = Data(base64Encoded: vectorBox)!
        raw[raw.count - 1] ^= 1
        XCTAssertThrowsError(try MemberBox.open(raw.base64EncodedString(), with: key(vectorPrivate)))
        XCTAssertThrowsError(try MemberBox.open(vectorBox, with: P256.KeyAgreement.PrivateKey()))
        XCTAssertThrowsError(try MemberBox.open("AAAA", with: key(vectorPrivate)))
    }

    func testOpensASealedCatalystPairing() throws {
        let p = try MemberBox.pairing(pairBox, with: key(pairPrivate))
        XCTAssertEqual(p.n, "Test Mac")
        XCTAssertTrue(p.onCatalyst)
        XCTAssertEqual(AccountEndpoints.appURL(fromRelay: p.cu), AccountEndpoints.defaultAppURL)
        // The vector's plaintext is not a pairing.
        XCTAssertThrowsError(try MemberBox.pairing(vectorBox, with: key(vectorPrivate)))
    }

    func testCallbackValidation() throws {
        let ok = URL(string: "squeak://signed-in?token=t0k&state=abc&email=a%40b.c&name=Ann%20B")!
        let s = try AccountEndpoints.parseSignedIn(ok, state: "abc")
        XCTAssertEqual(s, AccountSession(token: "t0k", email: "a@b.c", name: "Ann B"))
        XCTAssertThrowsError(try AccountEndpoints.parseSignedIn(ok, state: "abd")) { XCTAssertEqual($0 as? AccountEndpoints.SignInFailure, .wrongState) }
        XCTAssertThrowsError(try AccountEndpoints.parseSignedIn(URL(string: "squeak://pair?token=t&state=abc")!, state: "abc")) { XCTAssertEqual($0 as? AccountEndpoints.SignInFailure, .notOurs) }
        XCTAssertThrowsError(try AccountEndpoints.parseSignedIn(URL(string: "https://signed-in?token=t&state=abc")!, state: "abc"))
        XCTAssertThrowsError(try AccountEndpoints.parseSignedIn(URL(string: "squeak://signed-in?state=abc")!, state: "abc")) { XCTAssertEqual($0 as? AccountEndpoints.SignInFailure, .noToken) }
        XCTAssertThrowsError(try AccountEndpoints.parseSignedIn(URL(string: "squeak://signed-in?token=t")!, state: ""))
        // The router's other readers do not take it for a session.
        XCTAssertNil(SqueakLink.sessionId(from: ok))
    }

    func testStateAndSignInURL() {
        let a = AccountEndpoints.newState(), b = AccountEndpoints.newState()
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(a.count, 43)
        XCTAssertFalse(a.contains("+") || a.contains("/") || a.contains("="))
        XCTAssertEqual(AccountEndpoints.signInURL(appURL: "https://x.catalystserverless.in", state: a)?.absoluteString,
                       "https://x.catalystserverless.in/app/index.html#app-signin=\(a)")
        XCTAssertEqual(AccountEndpoints.appURL(fromRelay: nil), AccountEndpoints.defaultAppURL)
        XCTAssertEqual(AccountEndpoints.appURL(fromRelay: "https://evil.example/server/squeak_relay"), AccountEndpoints.defaultAppURL)
        XCTAssertEqual(AccountEndpoints.appURL(fromRelay: "https://app-1.development.catalystserverless.in/server/squeak_relay"), "https://app-1.development.catalystserverless.in")
    }

    final class Cell: @unchecked Sendable { var data: Data? }

    func testTokenStorage() {
        let cell = Cell()
        let s = AccountTokenStore(load: { cell.data }, save: { cell.data = $0 }, delete: { cell.data = nil })
        XCTAssertNil(s.current())
        s.store(AccountSession(token: "t", expiresAt: Date(timeIntervalSince1970: 1000), email: "e", name: "n"))
        XCTAssertEqual(s.current(now: Date(timeIntervalSince1970: 999))?.token, "t")
        XCTAssertNil(s.current(now: Date(timeIntervalSince1970: 1000)))
        XCTAssertNil(cell.data, "an expired sign-in is forgotten")
        s.store(AccountSession(token: "t", email: "e", name: "n"))
        s.signOut()
        XCTAssertNil(s.current())
    }

    /// A fake relay: answers a script (the last answer repeats), remembers requests.
    final class Fake: AccountHTTP, @unchecked Sendable {
        var answers: [(Int, String)]
        var requests: [URLRequest] = []
        init(_ answers: [(Int, String)]) { self.answers = answers }
        func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
            requests.append(request)
            let a = answers.count > 1 ? answers.removeFirst() : answers[0]
            if a.0 == -1 { throw URLError(.notConnectedToInternet) }
            return (a.0, Data(a.1.utf8))
        }
    }

    func api(_ fake: Fake) -> AccountAPI { AccountAPI(appURL: "https://a.catalystserverless.in", token: "TOK", http: fake) }

    func testMacsAndHeaders() async throws {
        let fake = Fake([(200, #"{"macs":[{"macId":"m1","name":"Studio","linkedAt":1},{"macId":"","name":"x"},{"macId":"m2"}]}"#)])
        let macs = try await api(fake).macs()
        XCTAssertEqual(macs, [AccountMac(macId: "m1", name: "Studio"), AccountMac(macId: "m2", name: "Your Mac")])
        XCTAssertEqual(fake.requests[0].value(forHTTPHeaderField: "x-squeak-account"), "TOK")
        XCTAssertEqual(fake.requests[0].url?.absoluteString, "https://a.catalystserverless.in/server/squeak_relay/account/macs")
        do { _ = try await api(Fake([(401, "{}")])).macs(); XCTFail() } catch { XCTAssertEqual(error as? AccountError, .signedOut) }
    }

    func testRequestStatuses() async throws {
        let k = P256.KeyAgreement.PrivateKey(), signer = SoftwareSigner()
        let mac = AccountMac(macId: "m1", name: "Studio")
        for (status, expected) in [(403, AccountError.macGone), (429, .busy)] {
            do {
                _ = try await AccountPairing.request(api: api(Fake([(status, #"{"error":"x"}"#)])), mac: mac, deviceName: "iPhone", publicKeyX963: signer.publicKeyX963, boxKey: k)
                XCTFail()
            } catch { XCTAssertEqual(error as? AccountError, expected) }
        }
        let fake = Fake([(200, #"{"reqId":"r-1","expiresAt":2000000000}"#)])
        let r = try await AccountPairing.request(api: api(fake), mac: mac, deviceName: "iPhone", publicKeyX963: signer.publicKeyX963, boxKey: k)
        XCTAssertEqual(r.reqId, "r-1")
        XCTAssertEqual(r.expiresAt, Date(timeIntervalSince1970: 2_000_000_000))
        XCTAssertEqual(r.code, ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963))
        let sent = try JSONSerialization.jsonObject(with: fake.requests[0].httpBody!) as! [String: String]
        XCTAssertEqual(sent["publicKey"], signer.publicKeyX963.base64EncodedString())
        XCTAssertEqual(sent["boxKey"], k.publicKey.x963Representation.base64EncodedString())
        XCTAssertEqual(sent["macId"], "m1")
    }

    func request(expires: Date? = nil) -> DeviceRequest {
        DeviceRequest(mac: AccountMac(macId: "m1", name: "Studio"), reqId: "r-1", expiresAt: expires, code: "123456", deviceName: "iPhone")
    }

    final class Sleeps: @unchecked Sendable { var values: [TimeInterval] = []; func add(_ v: TimeInterval) { values.append(v) } }

    func testPollsUntilApproved() async throws {
        let fake = Fake([(202, ""), (-1, ""), (202, ""), (200, #"{"result":{"box":"\#(pairBox)"}}"#)])
        let slept = Sleeps()
        let out = try await AccountPairing.await(api: api(fake), request: request(), boxKey: key(pairPrivate), sleep: { slept.add($0) })
        guard case .approved(let p, let id) = out else { return XCTFail("\(out)") }
        XCTAssertEqual(p.n, "Test Mac")
        XCTAssertEqual(id, "r-1")
        XCTAssertEqual(slept.values, [2, 2, 2])
    }

    func testDeniedGoneExpiredUnreadable() async throws {
        let k = try key(pairPrivate)
        var out = try await AccountPairing.await(api: api(Fake([(200, #"{"result":{"denied":true}}"#)])), request: request(), boxKey: k, sleep: { _ in })
        XCTAssertEqual(out, .denied)
        out = try await AccountPairing.await(api: api(Fake([(410, "")])), request: request(), boxKey: k, sleep: { _ in })
        XCTAssertEqual(out, .gone)
        out = try await AccountPairing.await(api: api(Fake([(202, "")])), request: request(expires: Date(timeIntervalSince1970: 5)), boxKey: k, now: { Date(timeIntervalSince1970: 6) }, sleep: { _ in })
        XCTAssertEqual(out, .expired)
        out = try await AccountPairing.await(api: api(Fake([(200, #"{"result":{"box":"AAAA"}}"#)])), request: request(), boxKey: k, sleep: { _ in })
        XCTAssertEqual(out, .failed(AccountError.unreadableSentence))
        do {
            _ = try await AccountPairing.await(api: api(Fake([(401, "")])), request: request(), boxKey: k, sleep: { _ in })
            XCTFail()
        } catch { XCTAssertEqual(error as? AccountError, .signedOut) }
    }

    func testCancelStopsPolling() async throws {
        let task = Task { try await AccountPairing.await(api: api(Fake([(202, "")])), request: request(), boxKey: P256.KeyAgreement.PrivateKey(), sleep: { _ in await Task.yield() }) }
        task.cancel()
        let out = try await task.value
        XCTAssertEqual(out, .cancelled)
    }
}
