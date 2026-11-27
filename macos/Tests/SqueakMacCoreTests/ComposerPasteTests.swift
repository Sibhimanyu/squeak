import Testing
@testable import SqueakMacCore

struct ComposerPasteTests {
    @Test func aScreenshotPNGIsAttached() {
        let facts = ComposerPaste.Facts(types: ["public.png"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .imageData(type: "public.png"))
    }

    @Test func aScreenshotWithPNGAndTIFFTakesThePNG() {
        let facts = ComposerPaste.Facts(types: ["public.tiff", "public.png"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .imageData(type: "public.png"))
    }

    @Test func aTIFFOnlyClipboardIsAttached() {
        let facts = ComposerPaste.Facts(types: ["public.tiff"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .imageData(type: "public.tiff"))
    }

    @Test func anOlderAppsLegacyTIFFNameIsAttached() {
        let facts = ComposerPaste.Facts(types: ["NeXT TIFF v4.0 pasteboard type"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .imageData(type: "NeXT TIFF v4.0 pasteboard type"))
    }

    @Test func aBrowsersCopyImageWithHTMLBesideItIsAttached() {
        let facts = ComposerPaste.Facts(types: ["public.html", "public.png"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .imageData(type: "public.png"))
    }

    @Test func aCopiedImageFileIsAttachedEvenWithItsNameAsText() {
        let facts = ComposerPaste.Facts(types: ["public.file-url", "public.utf8-plain-text", "public.tiff"], imageFileCount: 1)
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .imageFiles)
    }

    @Test func aCopiedNonImageFilePastesAsTextNotItsIcon() {
        // Finder also puts the file's icon (TIFF) on the pasteboard: it must not become an attachment.
        let facts = ComposerPaste.Facts(types: ["public.file-url", "public.utf8-plain-text", "public.tiff"], otherFileCount: 1)
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .text)
    }

    @Test func plainTextStillPastesAsText() {
        #expect(ComposerPaste.decide(ComposerPaste.Facts(types: ["public.utf8-plain-text"]), rawNeedsNoText: true) == .text)
        #expect(ComposerPaste.decide(ComposerPaste.Facts(types: ["NSStringPboardType", "public.html"]), rawNeedsNoText: true) == .text)
    }

    @Test func spreadsheetCellsWithAPictureBesideThemPasteTheWords() {
        let facts = ComposerPaste.Facts(types: ["public.utf8-plain-text", "public.html", "public.tiff"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: true) == .text)
    }

    @Test func aDropTakesThePictureEvenWithText() {
        let facts = ComposerPaste.Facts(types: ["public.utf8-plain-text", "public.png"])
        #expect(ComposerPaste.decide(facts, rawNeedsNoText: false) == .imageData(type: "public.png"))
    }

    @Test func anEmptyPasteboardIsText() {
        #expect(ComposerPaste.decide(ComposerPaste.Facts(types: []), rawNeedsNoText: true) == .text)
    }
}
