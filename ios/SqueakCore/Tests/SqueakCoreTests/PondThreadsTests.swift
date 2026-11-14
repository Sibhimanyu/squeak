import Foundation
import XCTest
@testable import SqueakCore

/// A pond's whole thread list (src/remote/pond-threads.ts) as the phone reads it.
final class PondThreadsTests: XCTestCase {
    func testDocumentIdMatchesTheMacs() {
        // node: sha256("pond:p-green") base64url, first 22 characters, then "-p".
        XCTAssertEqual(PondThreads.doc(for: "p-green"), "13Q3DYfT6ZIJtMwvC16Puw-p")
    }

    func testPresenceNamesPondthreads() {
        XCTAssertTrue(ChannelCrypto.capabilities.contains("pondthreads"))
        XCTAssertLessThanOrEqual(ChannelCrypto.capabilities.count + 1, 10)
        XCTAssertTrue(ChannelCrypto.capabilities.allSatisfy { $0.count <= 20 })
    }

    func testDecodesWhatTheMacActuallyWrites() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mac-made", withExtension: "json", subdirectory: "Fixtures"))
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let payload = try PairingPayload.parse(raw["pairingURL"] as! String)
        let doc = try ChannelCrypto.open(PondThreads.self, box: raw["pondThreadsBox"] as! String, key: payload.k)
        XCTAssertEqual(doc.pond, "p-green")
        XCTAssertEqual(doc.total, 3)
        // Main first, then the stream; newest first inside; the phone decides nothing.
        XCTAssertEqual(doc.streams.map(\.name), ["Main", "hong-kong"])
        XCTAssertEqual(doc.streams.first?.main, true)
        XCTAssertNil(doc.streams.last?.main)
        XCTAssertEqual(doc.streams.last?.threads.map(\.title), ["Menu", "Old"])
        XCTAssertEqual(doc.threads.count, 3)
        XCTAssertNotNil(doc.threads.first?.date)
        // Another member's own thread, marked as theirs, and the owner's switch for this person.
        XCTAssertEqual(doc.flock?.first?.by, "Aarav")
        XCTAssertEqual(doc.flock?.first?.poweredBy, "Powered by Aarav-mac \u{00B7} Flotilla")
        XCTAssertEqual(doc.flock?.first?.locked, true)
        XCTAssertEqual(doc.access, PondThreads.Access(canMessage: false, reason: "The owner has turned off messaging for you in this pond."))
    }

    func testAnOlderMacsDocumentHasNoFlockOrAccess() throws {
        let doc = try JSONDecoder().decode(PondThreads.self, from: Data(#"{"v":1,"pond":"p","total":0,"streams":[]}"#.utf8))
        XCTAssertNil(doc.flock)
        XCTAssertNil(doc.access)
    }

    func testAnOlderThreadBecomesABareSessionTheRowAndHistoryCanUse() {
        let thread = PondThreads.Thread(key: "squeak-native:b", title: "Menu", state: "finished", at: "2026-09-20T00:00:00.000Z")
        let session = thread.asSession
        XCTAssertEqual(session.key, "squeak-native:b")
        XCTAssertEqual(session.title, "Menu")
        XCTAssertEqual(session.state, "finished")
        XCTAssertNil(session.message)
    }
}
