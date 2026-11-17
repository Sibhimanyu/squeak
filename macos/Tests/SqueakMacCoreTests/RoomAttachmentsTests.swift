import CoreGraphics
import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Room attachments")
struct RoomAttachmentsTests {
    private let png = PreparedImage(data: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1]), ext: "png")

    @Test func decodesPostsWithAndWithoutAttachments() throws {
        let json = """
        {"posts":[
          {"seq":1,"id":"a","author":{"kind":"person","name":"Sam"},"kind":"message","level":"room","text":"see","at":5,
           "attachments":[{"id":"x","kind":"image","name":"image-1.png","mime":"image/png","size":900,"url":"/native/projects/p/room/attachments/x","width":640,"height":480},
                          {"id":"y","kind":"zzz","name":"n.pdf","size":5,"url":"/u"},{"nope":1}]},
          {"seq":2,"id":"b","author":{"kind":"person","name":"Sam"},"text":"plain","at":6}],"latestSeq":2,"threads":[]}
        """
        let page = try JSONDecoder().decode(RoomPage.self, from: Data(json.utf8))
        let first = page.posts[0].attachments
        #expect(first.count == 2)
        #expect(first[0].kind == .image && first[0].pixelSize == CGSize(width: 640, height: 480) && first[0].size == 900)
        #expect(first[1].kind == .file && first[1].pixelSize == nil)
        #expect(page.posts[1].attachments.isEmpty)
    }

    @Test func imageLimitCountsPicturesStillBeingPrepared() {
        var d = RoomAttachmentDraft()
        for _ in 0..<RoomAttachmentLimits.maxImages { let ok = d.beginImage(); #expect(ok) }
        let over = d.beginImage()
        #expect(!over)
        #expect(d.error?.contains("Up to 4 images") == true)
        #expect(!d.canSend(text: "hi"))  // still preparing
        for i in 0..<RoomAttachmentLimits.maxImages { d.finishImage(png, name: "p\(i)") }
        #expect(d.images.count == 4 && d.preparing == 0 && d.error == nil)
        #expect(d.canSend(text: ""))
        #expect(d.isFull(.image))
    }

    @Test func aPictureThatCannotBeReadIsAnInlineErrorAndFreesItsPlace() {
        var d = RoomAttachmentDraft()
        _ = d.beginImage()
        d.finishImage(nil, name: "x")
        #expect(d.items.isEmpty && d.preparing == 0 && d.error != nil)
        #expect(!d.canSend(text: "  "))
        let again = d.beginImage()
        #expect(again)  // the place is free again and the error is cleared
        #expect(d.error == nil)
    }

    @Test func filesAreCheckedForSizeEmptinessCountAndTotal() {
        var d = RoomAttachmentDraft()
        d.addFile(name: "empty.txt", data: Data())
        #expect(d.items.isEmpty && d.error?.contains("empty") == true)
        d.addFile(name: "big.bin", data: Data(count: RoomAttachmentLimits.maxFileBytes + 1))
        #expect(d.items.isEmpty && d.error?.contains("over 5 MB") == true)
        d.addFile(name: "ok.pdf", data: Data(count: 10))
        #expect(d.files.count == 1 && d.error == nil)
        for i in 0..<RoomAttachmentLimits.maxFiles { d.addFile(name: "f\(i)", data: Data(count: 1)) }
        #expect(d.files.count == RoomAttachmentLimits.maxFiles && d.error?.contains("Up to 4 files") == true)

        var t = RoomAttachmentDraft()
        for i in 0..<3 { t.addFile(name: "b\(i)", data: Data(count: RoomAttachmentLimits.maxFileBytes)) }
        #expect(t.files.count == 3)
        t.addFile(name: "b3", data: Data(count: RoomAttachmentLimits.maxFileBytes))
        #expect(t.files.count == 3 && t.error?.contains("16 MB") == true)
    }

    @Test func removeAndClearAndSendRule() {
        var d = RoomAttachmentDraft()
        #expect(!d.canSend(text: "  \n"))
        #expect(d.canSend(text: "hi"))
        d.addFile(name: "a.txt", data: Data(count: 3))
        #expect(d.canSend(text: ""))  // an attachment alone is a message
        d.remove(d.items[0].id)
        #expect(d.isEmpty && !d.canSend(text: ""))
        d.addFile(name: "a.txt", data: Data(count: 3))
        d.clear()
        #expect(d.isEmpty && d.error == nil)
    }

    @Test func wireCarriesNameAndBase64() {
        let items = [OutgoingAttachment(kind: .file, name: "a.txt", data: Data("hi".utf8))]
        #expect(RoomAttachmentDraft.wire(items) == .array([.object(["name": .string("a.txt"), "data": .string("aGk=")])]))
    }

    @Test func gridSizes() {
        #expect(RoomAttachmentGrid.columns(count: 1) == 1)
        #expect(RoomAttachmentGrid.columns(count: 2) == 2 && RoomAttachmentGrid.columns(count: 4) == 2)
        #expect(RoomAttachmentGrid.rows(count: 0) == 0 && RoomAttachmentGrid.rows(count: 1) == 1)
        #expect(RoomAttachmentGrid.rows(count: 3) == 2 && RoomAttachmentGrid.rows(count: 4) == 2)
        // one picture keeps its aspect, never wider than 240, never enlarged
        #expect(RoomAttachmentGrid.sizes(naturals: [CGSize(width: 1200, height: 600)]) == [CGSize(width: 240, height: 120)])
        #expect(RoomAttachmentGrid.sizes(naturals: [CGSize(width: 100, height: 50)]) == [CGSize(width: 100, height: 50)])
        #expect(RoomAttachmentGrid.sizes(naturals: [CGSize(width: 600, height: 1200)]) == [CGSize(width: 120, height: 240)])
        // an unknown size still has a shape, so the row never depends on loading
        #expect(RoomAttachmentGrid.sizes(naturals: [nil]).count == 1)
        // several: equal square tiles in two columns, 240 wide in all
        let tiles = RoomAttachmentGrid.sizes(naturals: [nil, CGSize(width: 10, height: 90), nil])
        #expect(tiles.count == 3 && Set(tiles.map(\.width)).count == 1)
        #expect(tiles[0].width * 2 + RoomAttachmentGrid.spacing <= RoomAttachmentGrid.maxWidth)
        #expect(RoomAttachmentGrid.sizes(naturals: []).isEmpty)
    }

    @Test func sizeTextAndLabels() {
        #expect(RoomAttachmentText.size(512) == "512 B")
        #expect(RoomAttachmentText.size(420_000) == "420 KB")
        #expect(RoomAttachmentText.size(1_250_000) == "1.2 MB")
        #expect(RoomAttachmentText.label(RoomAttachment(id: "1", kind: .file, name: "a.pdf", size: 2000)) == "File, a.pdf, 2 KB")
        #expect(RoomAttachmentText.label(RoomAttachment(id: "1", kind: .image, name: "p.png")) == "Image, p.png")
    }

    @Test func aPendingPostShowsItsAttachmentsAndTheHostsCopyReplacesThem() {
        let item = OutgoingAttachment(kind: .image, name: "p.png", data: png.data, width: 10, height: 20)
        var f = RoomFeed()
        f.apply(page: RoomPage(posts: [], latestSeq: 0))
        let id = f.addPending(text: "look", level: .room, author: RoomAuthor(kind: .person, name: "You"), at: 1, attachments: [item.placeholder])
        #expect(f.rows[0].post.attachments.count == 1 && f.rows[0].post.attachments[0].isLocal)
        #expect(f.rows[0].post.attachments[0].pixelSize == CGSize(width: 10, height: 20))
        let real = RoomPost(seq: 1, id: "p1", author: RoomAuthor(kind: .person, name: "Sam"), text: "look",
                            attachments: [RoomAttachment(id: "x", kind: .image, name: "image-1.png", url: "/native/x")], at: 2)
        #expect(f.receive(real) == .none)
        #expect(f.rows.count == 1 && f.rows[0].id == id && !f.rows[0].pending)
        #expect(f.rows[0].post.attachments[0].isLocal == false)
    }

    @Test func aPictureAloneIsAMessageWithNoEmptyBubble() {
        var f = RoomFeed()
        let att = RoomAttachment(id: "x", kind: .image, name: "i.png", url: "/native/x")
        f.apply(page: RoomPage(posts: [RoomPost(seq: 1, id: "p1", author: RoomAuthor(kind: .person, name: "Sam"), text: "", attachments: [att], at: 1000)], latestSeq: 1))
        let items = RoomMessages.build(feed: f, owner: "Sam", filesFor: { _ in nil })
        var found: RoomMessage?
        for case .group(let g) in items { found = g.messages.first }
        #expect(found?.attachments == [att] && found?.parts.isEmpty == true)
    }

    @Test func fileNamesAreCleaned() {
        #expect(RoomAttachmentFiles.cleanName("../../etc/passwd") == "passwd")
        #expect(RoomAttachmentFiles.cleanName("..\\x\\.hidden") == "hidden")
        #expect(RoomAttachmentFiles.cleanName("") == "file")
        #expect(RoomAttachmentFiles.cleanName("a\nb.txt") == "ab.txt")
        #expect(RoomAttachmentFiles.cleanName(String(repeating: "x", count: 200) + ".pdf").count == 80)
    }

    @Test func aDucksMessageNamesPicturesAndFilesLikeAChat() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("room-att-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let images = try ImageAttachments.save([png], into: dir.path)
        let files = try RoomAttachmentFiles.save([("spec.pdf", Data("hello".utf8)), ("spec.pdf", Data("two".utf8))], into: dir.path)
        #expect(files.count == 2 && files[0].hasSuffix("/spec.pdf") && files[1].hasSuffix("/2-spec.pdf"))
        #expect(try Data(contentsOf: dir.appendingPathComponent(files[0])) == Data("hello".utf8))
        let text = RoomAttachmentFiles.compose("fix it", imageRefs: images, fileRefs: files)
        #expect(text.hasPrefix("fix it\n\n@⟦image-1.png⟧("))
        #expect(text.hasSuffix("Attached file: \(files[1])"))
        #expect(RoomAttachmentFiles.compose("", imageRefs: [], fileRefs: [files[0]]).hasPrefix("See the attached file."))
        #expect(RoomAttachmentFiles.compose("", imageRefs: images, fileRefs: []) == ImageAttachments.compose("", refs: images))
    }

    @Test func refusesASymlinkedContextFolder() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("room-att-\(UUID().uuidString)")
        let elsewhere = FileManager.default.temporaryDirectory.appendingPathComponent("room-else-\(UUID().uuidString)")
        for d in [dir, elsewhere] { try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
        defer { for d in [dir, elsewhere] { try? FileManager.default.removeItem(at: d) } }
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent(".context"), withDestinationURL: elsewhere)
        #expect(throws: ImageAttachmentError.folderUnsafe) { try RoomAttachmentFiles.save([("a", Data("x".utf8))], into: dir.path) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere.path).isEmpty)
    }
}
