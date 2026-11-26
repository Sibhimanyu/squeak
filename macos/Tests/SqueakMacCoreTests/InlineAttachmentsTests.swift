import SqueakMacCore
import XCTest

final class InlineAttachmentsTests: XCTestCase {
    let one = "@⟦image-1.png⟧(.context%2Fattachments%2Fc39f865b%2Fimage-1.png)"
    let two = "@⟦notes.pdf⟧(docs%2Fnotes.pdf)"

    func testSegmentsKeepWordsAndTokensInOrder() {
        let segs = InlineAttachments.segments("Compare \(one) with \(two).")
        XCTAssertEqual(segs.count, 5)
        XCTAssertEqual(segs[0], .text("Compare "))
        guard case .token(let t) = segs[1], case .token(let f) = segs[3] else { return XCTFail("tokens") }
        XCTAssertEqual(t.name, "image-1.png")
        XCTAssertEqual(t.path, ".context/attachments/c39f865b/image-1.png")
        XCTAssertTrue(t.isImage)
        XCTAssertFalse(f.isImage)
        XCTAssertEqual(segs[4], .text("."))
        XCTAssertEqual(InlineAttachments.segments("plain"), [.text("plain")])
        XCTAssertEqual(InlineAttachments.segments(""), [])
    }

    func testDisplayHoldsOneCharacterPerTokenAndMapsBackExactly() {
        let text = "a \(one) b \(two)"
        let d = InlineAttachments.display(text)
        XCTAssertEqual(d.string, "a \u{FFFC} b \u{FFFC}")
        XCTAssertEqual(InlineAttachments.storage(d.string, tokens: d.tokens), text)
    }

    func testBackspaceOverAChipDeletesTheWholeToken() {
        let text = "see \(one) here"
        let d = InlineAttachments.display(text)
        // The caret sits after the chip: one Backspace removes one display character, the attachment.
        var shown = d.string
        let chip = shown.firstIndex(of: "\u{FFFC}")!
        shown.remove(at: chip)
        XCTAssertEqual(InlineAttachments.storage(shown, tokens: []), "see  here")
        // The caret steps over a chip in one move: it is one UTF-16 unit in the view.
        XCTAssertEqual(InlineAttachments.displayOffset(ofStorage: ("see \(one)" as NSString).length, in: text), 5)
    }

    func testPendingTokensResolveInPlaceKeepingTheirName() {
        let p = InlineAttachments.pendingToken(name: "Screenshot.png", id: "A1")
        let text = "before \(p) after"
        XCTAssertEqual(InlineAttachments.pendingIds(in: text), ["A1"])
        let sent = InlineAttachments.resolve(text, refs: ["A1": ".context/attachments/ff/image-1.png"])
        XCTAssertEqual(sent, "before @⟦Screenshot.png⟧(.context%2Fattachments%2Fff%2Fimage-1.png) after")
        XCTAssertEqual(InlineAttachments.removing(pendingId: "A1", from: text), "before  after")
    }

    func testOnlyPicturesGetALineAskingToLook() {
        let p = InlineAttachments.pendingToken(name: "image-1.png", id: "A1")
        XCTAssertEqual(InlineAttachments.resolve(p, refs: ["A1": "x/image-1.png"]), "See the attached image.\n\n@⟦image-1.png⟧(x%2Fimage-1.png)")
        XCTAssertEqual(InlineAttachments.resolve("hi \(p)", refs: [:]), "hi")
    }

    func testChipNameKeepsTheExtension() {
        XCTAssertEqual(InlineAttachments.chipName("image-1.png"), "image-1.png")
        let short = InlineAttachments.chipName("Screenshot 2026-11-26 at 15.10.42.png")
        XCTAssertTrue(short.hasSuffix("0.42.png"))
        XCTAssertLessThanOrEqual(short.count, 22)
    }

    func testASentMessageFlowsAsWordsLineBreaksAndChips() {
        let pieces = InlineAttachments.pieces("Look at \(one) now\nthanks")
        XCTAssertEqual(pieces.count, 7)
        XCTAssertEqual(pieces[0], .word("Look "))
        XCTAssertEqual(pieces[1], .word("at "))
        guard case .token(let t) = pieces[2] else { return XCTFail("chip") }
        XCTAssertEqual(t.name, "image-1.png")
        XCTAssertEqual(pieces[3], .word(" "))
        XCTAssertEqual(Array(pieces[4...]), [.word("now"), .newline, .word("thanks")])
    }
}
