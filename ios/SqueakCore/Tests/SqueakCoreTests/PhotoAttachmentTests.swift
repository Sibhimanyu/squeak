import XCTest
@testable import SqueakCore

final class PhotoAttachmentTests: XCTestCase {
    func testAPhotoGoesInChunksThatFitTheChannel() {
        let data = Data(repeating: 1, count: PhotoAttachment.chunkBytes * 2 + 10)
        let chunks = PhotoAttachment.chunks(of: data)
        XCTAssertEqual(chunks.map(\.count), [PhotoAttachment.chunkBytes, PhotoAttachment.chunkBytes, 10])
        XCTAssertEqual(chunks.reduce(Data(), +), data)
        XCTAssertEqual(PhotoAttachment.chunks(of: Data()), [])
    }

    func testTheMessageNamesEachSavedPhotoOnItsOwnLine() {
        let refs = [".context/attachments/ab12cd34/image-1.jpg", ".context/attachments/ef56ab78/image-1.png"]
        let text = PhotoAttachment.compose("What is wrong here?", refs: refs)
        XCTAssertEqual(text, "What is wrong here?\n\n[Image: \(refs[0])]\n[Image: \(refs[1])]")
        let shown = PhotoAttachment.split(text)
        XCTAssertEqual(shown.body, "What is wrong here?")
        XCTAssertEqual(shown.refs, refs)
    }

    func testAPhotoWithNoWordsAsksTheAgentToLook() {
        XCTAssertEqual(PhotoAttachment.compose("  ", refs: [".context/attachments/ab12cd34/image-1.jpg"]),
                       "See the attached image.\n\n[Image: .context/attachments/ab12cd34/image-1.jpg]")
        XCTAssertTrue(PhotoAttachment.compose("", refs: Array(repeating: ".context/attachments/ab12cd34/image-1.jpg", count: 2)).hasPrefix("See the attached images."))
        XCTAssertEqual(PhotoAttachment.compose(" hi ", refs: []), "hi")
    }

    func testOnlyOurOwnMarkerLinesAreTakenOutOfAMessage() {
        let ordinary = "Use [Image: not a path] in the docs\n[Image: ../../etc/passwd]"
        XCTAssertEqual(PhotoAttachment.split(ordinary).body, ordinary)
        XCTAssertEqual(PhotoAttachment.split(ordinary).refs, [])
    }
}
