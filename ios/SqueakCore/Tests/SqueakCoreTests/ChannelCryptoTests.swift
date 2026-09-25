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
