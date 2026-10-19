import CryptoKit
import Foundation
import XCTest
@testable import SqueakCore

final class ChannelCryptoTests: XCTestCase {
    struct Hello: Codable, Equatable { let hello: String; let n: Int }

    /// Sealed by the Mac's own code (src/remote/remote-crypto.ts).
    func testOpensABoxSealedByTheMac() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "node-made", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        let value = try ChannelCrypto.open(Hello.self, box: fixture["box"]!, key: fixture["key"]!)
        XCTAssertEqual(value, Hello(hello: "from node", n: 7))
    }

    func testRoundTripAndTamperDetection() throws {
        let key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }.base64EncodedString()
        let box = try ChannelCrypto.seal(Hello(hello: "x", n: 1), key: key)
        XCTAssertEqual(try ChannelCrypto.open(Hello.self, box: box, key: key), Hello(hello: "x", n: 1))
        var raw = Data(base64Encoded: box)!
        raw[14] ^= 0xFF
        XCTAssertThrowsError(try ChannelCrypto.open(Hello.self, box: raw.base64EncodedString(), key: key))
    }

    func testSignaturesVerifyWithTheSamePublicKey() throws {
        let signer = SoftwareSigner()
        let signature = try signer.sign("box")
        let key = try P256.Signing.PublicKey(x963Representation: signer.publicKeyX963)
        let raw = try P256.Signing.ECDSASignature(rawRepresentation: Data(base64Encoded: signature)!)
        XCTAssertTrue(key.isValidSignature(raw, for: Data("box".utf8)))
        XCTAssertEqual(ChannelCrypto.pairingCode(publicKeyX963: signer.publicKeyX963).count, 6)
    }
}

final class SqueakLinkTests: XCTestCase {
    func testReadsTheSessionFromSqueakLinks() {
        let id = "289014c4-b06d-4bae-92c6-7ed94912e6bd"
        XCTAssertEqual(SqueakLink.sessionId(from: URL(string: "squeak://open?s=\(id)")!), id)
        XCTAssertEqual(SqueakLink.sessionId(from: URL(string: "squeak://squeak?s=\(id)")!), id)
    }

    func testIgnoresEverythingElse() {
        XCTAssertNil(SqueakLink.sessionId(from: URL(string: "squeak://farm?s=289014c4")!))
        XCTAssertNil(SqueakLink.sessionId(from: URL(string: "other://open?s=289014c4-b06d")!))
        XCTAssertNil(SqueakLink.sessionId(from: URL(string: "squeak://open")!))
        XCTAssertNil(SqueakLink.sessionId(from: URL(string: "squeak://open?s=../../etc")!))
        XCTAssertNil(SqueakLink.sessionId(from: URL(string: "squeak://open?s=abc")!))
    }
}
