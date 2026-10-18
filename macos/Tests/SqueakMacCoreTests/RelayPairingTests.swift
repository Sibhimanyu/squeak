import XCTest

@testable import SqueakMacCore

final class RelayPairingTests: XCTestCase {
    func testParsesNodeBuiltLinks() throws {
        let p = try RelayVectors.load().dict("pairing")
        let d = try RelayPairing.parse(p.s("defaultLink"))
        XCTAssertEqual(d.version, 2)
        XCTAssertEqual(hexString(d.hostStaticPublicKey), p.s("hostStaticPublicKey"))
        XCTAssertEqual(hexString(d.pairingToken), p.s("pairingToken"))
        XCTAssertEqual(d.pairingTokenExpiresAt.timeIntervalSince1970, TimeInterval(p["expiresAtSeconds"] as! Int))
        XCTAssertEqual(d.hostName, "Sibhi-Mac")
        XCTAssertEqual(d.relayUrl, p.s("defaultRelayUrl"))
        XCTAssertEqual(d.relayUrl, "https://api.conductor.build")
        XCTAssertEqual(d.hostId, p.s("hostId"))
        XCTAssertEqual(d.hostId.count, 22)

        let c = try RelayPairing.parse(p.s("customLink"))
        XCTAssertEqual(c.relayUrl, "http://127.0.0.1:8599")
        XCTAssertEqual(c.hostId, d.hostId)
    }

    func testLowercasePrefixAndWhitespaceAccepted() throws {
        let p = try RelayVectors.load().dict("pairing")
        let link = "  " + p.s("defaultLink").replacingOccurrences(of: "CONDUCTOR://P/", with: "conductor://p/") + "\n"
        XCTAssertEqual(try RelayPairing.parse(link).hostName, "Sibhi-Mac")
    }

    func testRejectsNonPairingAndTruncated() throws {
        XCTAssertThrowsError(try RelayPairing.parse("https://example.com")) {
            XCTAssertTrue(($0 as? RelayError)!.message.contains("not a CONDUCTOR"))
        }
        let p = try RelayVectors.load().dict("pairing")
        XCTAssertThrowsError(try RelayPairing.parse(String(p.s("defaultLink").prefix(30))))
    }
}
