import XCTest
@testable import SqueakCore

final class PondRoomTests: XCTestCase {
    func testRoomDocumentIdAndCapabilityMatchTheMacs() {
        // node: sha256("room:p-green") base64url, first 22 characters, then "-r".
        XCTAssertEqual(PondRoomDoc.doc(for: "p-green"), LiveTurn.handle(for: "room:p-green") + "-r")
        XCTAssertTrue(ChannelCrypto.capabilities.contains("pondroom"))
    }

    func testDecodesTheRoomTheMacBuiltFromTheHostsPage() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mac-made", withExtension: "json", subdirectory: "Fixtures"))
        let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let payload = try PairingPayload.parse(raw["pairingURL"] as! String)
        let doc = try ChannelCrypto.open(PondRoomDoc.self, box: raw["pondRoomBox"] as! String, key: payload.k)
        XCTAssertEqual(doc.pond, "p-green")
        XCTAssertTrue(doc.canPost)
        XCTAssertTrue(doc.canTask)
        XCTAssertEqual(doc.items.map(\.id), ["post-1", "task:task:1", "post-2", "post-3", "post-4", "post-5"])
        guard case .message(let first) = doc.items[0], case .task(let card) = doc.items[1],
              case .duck(let line) = doc.items[2], case .message(let last) = doc.items[3] else {
            return XCTFail("rows decode to their kinds")
        }
        XCTAssertTrue(first.mine)
        XCTAssertEqual(first.who, "You")
        XCTAssertNil(first.canTask, "a message that has a Task is not offered Make task again")
        XCTAssertEqual(card.state, .working)
        XCTAssertEqual(card.stateLabel, "Working")
        XCTAssertEqual(card.routing, "\u{2192} given to Pixel (related to the icon work)")
        XCTAssertEqual(card.canDrop, true)
        XCTAssertEqual(line.who, "Pixel")
        XCTAssertEqual(line.tone, .working)
        XCTAssertEqual(line.line, "Re-rendering the menu icons at 2x")
        XCTAssertEqual(line.detail, "Re-rendering the menu icons at 2x\nChecked four sizes; the 16 px one is blurry.")
        XCTAssertFalse(last.mine)
        XCTAssertEqual(last.who, "Aarav")
        guard case .duck(let plan) = doc.items[4], case .duck(let done) = doc.items[5] else { return XCTFail("a plan and a done line") }
        XCTAssertEqual(plan.plan, true)
        XCTAssertEqual(plan.detail, "Plan: crisp icons at 2x\nSpec: every menu icon at 2x.\nPlan: 1. re-render 2. check 16 px")
        XCTAssertNil(line.plan)
        XCTAssertNil(line.canvases)
        XCTAssertEqual(done.canvases, [.init(id: "c0ffee", title: "Icon sheet", subtitle: "Deck \u{00B7} 3 artboards")])
    }

    func testAnOlderMacsDuckLineStillDecodesWithoutPlanOrCanvases() throws {
        let json = #"{"v":1,"pond":"p","canPost":true,"canTask":false,"items":[{"t":"duck","id":"d","who":"Pixel","tone":"done","line":"Done","at":1}]}"#
        let doc = try JSONDecoder().decode(PondRoomDoc.self, from: Data(json.utf8))
        guard case .duck(let line) = doc.items[0] else { return XCTFail("a duck line") }
        XCTAssertNil(line.plan)
        XCTAssertNil(line.canvases)
    }

    func testEncodingARowKeepsItsKindSoTheMacReadsWhatThePhoneWrote() throws {
        let doc = PondRoomDoc(pond: "p", canPost: true, canTask: false, items: [
            .message(.init(id: "a", who: "You", mine: true, text: "hi", at: 1)),
            .duck(.init(id: "b", who: "Pixel", tone: .done, line: "Done", at: 2)),
            .task(.init(id: "task:c", taskId: "c", title: "T", state: .waiting, stateLabel: "Waiting", at: 3)),
        ])
        let back = try JSONDecoder().decode(PondRoomDoc.self, from: JSONEncoder().encode(doc))
        XCTAssertEqual(back, doc)
    }

    func testAnUnknownRowKindFailsTheDocumentRatherThanDrawingGuesses() {
        let json = #"{"v":1,"pond":"p","canPost":true,"canTask":false,"items":[{"t":"poll","id":"x"}]}"#
        XCTAssertThrowsError(try JSONDecoder().decode(PondRoomDoc.self, from: Data(json.utf8)))
    }

    func testASentMessageStaysUntilTheRoomShowsItBack() {
        let sent = PondRoomPending(id: "l1", text: "ship it", at: 1_000_000)
        var doc: PondRoomDoc? = nil
        XCTAssertEqual(PondRoomFeed.remaining([sent], in: doc), [sent])
        doc = PondRoomDoc(pond: "p", canPost: true, canTask: true, items: [
            .message(.init(id: "x", who: "Sam", mine: false, text: "ship it", at: 1_000_500)),
        ])
        XCTAssertEqual(PondRoomFeed.remaining([sent], in: doc), [sent], "someone else's same words are not mine")
        doc = PondRoomDoc(pond: "p", canPost: true, canTask: true, items: [
            .message(.init(id: "y", who: "You", mine: true, text: "ship it", at: 1_000_500)),
        ])
        XCTAssertEqual(PondRoomFeed.remaining([sent], in: doc), [])
    }

    func testAnOlderIdenticalMessageDoesNotSwallowANewPendingOne() {
        let sent = PondRoomPending(id: "l1", text: "ok", at: 10_000_000)
        let doc = PondRoomDoc(pond: "p", canPost: true, canTask: true, items: [
            .message(.init(id: "old", who: "You", mine: true, text: "ok", at: 1_000)),
        ])
        XCTAssertEqual(PondRoomFeed.remaining([sent], in: doc), [sent])
    }

    func testAFailedMessageStaysUntilDismissed() {
        let failed = PondRoomPending(id: "l1", text: "x", failed: "Your Mac didn't answer in time.", at: 1)
        let doc = PondRoomDoc(pond: "p", canPost: true, canTask: true, items: [
            .message(.init(id: "y", who: "You", mine: true, text: "x", at: 5)),
        ])
        XCTAssertEqual(PondRoomFeed.remaining([failed], in: doc), [failed])
    }

    func testRoomCommandsAreSignedWithExactlyTheirKeys() throws {
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        let channel = Channel(pairing: PairingPayload(v: 1, p: "p", c: "AAAAAAAAAAAAAAAAAAAAAA", k: key, n: "Mac"), deviceId: "phone-1", transport: FakeTransport())
        let signer = SoftwareSigner()
        func keys(_ change: Channel.PondChange) throws -> Set<String> {
            let (_, document) = try channel.pondDocument(change, signer: signer)
            return Set(try ChannelCrypto.open([String: AnyCodable].self, box: document.box, key: key).keys)
        }
        XCTAssertEqual(try keys(.roomPost(pondId: "p", text: " hi ")), ["v", "kind", "op", "pondId", "text", "nonce", "expiresAt"])
        XCTAssertEqual(try keys(.roomTask(pondId: "p", messageId: "m")), ["v", "kind", "op", "pondId", "messageId", "nonce", "expiresAt"])
        XCTAssertEqual(try keys(.roomDrop(pondId: "p", taskId: "t")), ["v", "kind", "op", "pondId", "taskId", "nonce", "expiresAt"])
        XCTAssertThrowsError(try keys(.roomPost(pondId: "p", text: "   ")))
        XCTAssertThrowsError(try keys(.roomPost(pondId: "p", text: String(repeating: "x", count: PondRoomDoc.maxText + 1))))
    }
}
