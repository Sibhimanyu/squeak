import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import SqueakMacCore

@Suite struct ImageAttachmentsTests {
    private func png(width: Int, height: Int, noisy: Bool = false) -> Data {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.9, green: 0.7, blue: 0.1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if noisy {
            for _ in 0..<4000 {
                ctx.setFillColor(CGColor(red: .random(in: 0...1), green: .random(in: 0...1), blue: .random(in: 0...1), alpha: 1))
                ctx.fill(CGRect(x: Int.random(in: 0..<width), y: Int.random(in: 0..<height), width: 40, height: 40))
            }
        }
        let out = NSMutableData()
        let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        CGImageDestinationFinalize(dest)
        return out as Data
    }

    private func size(of data: Data) -> (Int, Int) {
        let src = CGImageSourceCreateWithData(data as CFData, nil)!
        let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as! [CFString: Any]
        return (p[kCGImagePropertyPixelWidth] as! Int, p[kCGImagePropertyPixelHeight] as! Int)
    }

    private func tempDir() throws -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("sq-img-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    @Test func composeMatchesThePhone() {
        let r = ".context/attachments/0123abcd/image-1.png"
        #expect(ImageAttachments.compose("  look  ", refs: [r]) == "look\n\n@⟦image-1.png⟧(.context%2Fattachments%2F0123abcd%2Fimage-1.png)")
        #expect(ImageAttachments.compose("", refs: [r]) == "See the attached image.\n\n@⟦image-1.png⟧(.context%2Fattachments%2F0123abcd%2Fimage-1.png)")
        #expect(ImageAttachments.compose("", refs: [r, r]).hasPrefix("See the attached images."))
        #expect(ImageAttachments.compose(" hi ", refs: []) == "hi")
    }

    @Test func kindReadsBytesNotNames() {
        #expect(ImageAttachments.kind(of: png(width: 4, height: 4)) == "png")
        #expect(ImageAttachments.kind(of: Data([0xFF, 0xD8, 0xFF, 0xE0, 0])) == "jpg")
        #expect(ImageAttachments.kind(of: Data("hello".utf8)) == nil)
    }

    @Test func prepareDownscalesAndNeverUpscales() throws {
        let big = try #require(ImageAttachments.prepare(png(width: 3200, height: 1600)))
        #expect(size(of: big.data) == (1600, 800))
        #expect(big.data.count <= ImageAttachments.maxBytes)
        let small = try #require(ImageAttachments.prepare(png(width: 200, height: 100)))
        #expect(size(of: small.data) == (200, 100))
        #expect(small.ext == "png")
    }

    @Test func prepareFallsToJpegWhenPngIsTooHeavy() throws {
        let heavy = try #require(ImageAttachments.prepare(png(width: 2400, height: 2400, noisy: true)))
        #expect(heavy.data.count <= ImageAttachments.maxBytes)
        #expect(ImageAttachments.kind(of: heavy.data) == heavy.ext)
    }

    @Test func prepareRefusesNonImages() {
        #expect(ImageAttachments.prepare(Data("not an image".utf8)) == nil)
        #expect(ImageAttachments.prepare(Data()) == nil)
    }

    @Test func saveWritesUnderContextAttachments() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let a = try #require(ImageAttachments.prepare(png(width: 50, height: 50)))
        let refs = try ImageAttachments.save([a, a], into: dir.path, makeID: { "0123abcd" })
        #expect(refs == [".context/attachments/0123abcd/image-1.png", ".context/attachments/0123abcd/image-2.png"])
        for r in refs {
            let url = dir.appendingPathComponent(r)
            #expect(try Data(contentsOf: url) == a.data)
            let perm = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int
            #expect(perm == 0o600)
        }
    }

    @Test func saveNeverOverwritesAnExistingFolder() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let a = try #require(ImageAttachments.prepare(png(width: 20, height: 20)))
        var ids = ["aaaaaaaa", "aaaaaaaa", "bbbbbbbb"]
        let first = try ImageAttachments.save([a], into: dir.path, makeID: { ids.removeFirst() })
        let second = try ImageAttachments.save([a], into: dir.path, makeID: { ids.removeFirst() })
        #expect(first == [".context/attachments/aaaaaaaa/image-1.png"])
        #expect(second == [".context/attachments/bbbbbbbb/image-1.png"])
    }

    @Test func saveRefusesMissingFolderSymlinksAndFakeImages() throws {
        let dir = try tempDir(); defer { try? FileManager.default.removeItem(at: dir) }
        let a = try #require(ImageAttachments.prepare(png(width: 20, height: 20)))
        #expect(throws: ImageAttachmentError.folderMissing) { try ImageAttachments.save([a], into: dir.appendingPathComponent("gone").path) }
        #expect(throws: ImageAttachmentError.notAnImage) {
            try ImageAttachments.save([PreparedImage(data: Data("x".utf8), ext: "png")], into: dir.path)
        }
        let elsewhere = try tempDir(); defer { try? FileManager.default.removeItem(at: elsewhere) }
        try FileManager.default.createSymbolicLink(at: dir.appendingPathComponent(".context"), withDestinationURL: elsewhere)
        #expect(throws: ImageAttachmentError.folderUnsafe) { try ImageAttachments.save([a], into: dir.path) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere.path).isEmpty)
    }

    @Test func attachmentsNeedAFolderToWriteTo() throws {
        let json = #"{"active":[{"key":"conductor:a","origin":"conductor","state":"finished","replyTarget":"a","cwd":"/tmp/ws"},{"key":"conductor:b","origin":"conductor","state":"finished","replyTarget":"b"}]}"#
        let mapped = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8)).sessions.map(ConductorDaemonAdapter.map)
        #expect(mapped[0].capabilities.attachments.isSupported)
        #expect(!mapped[1].capabilities.attachments.isSupported)
        let w = try JSONDecoder().decode(NewChatWorkspace.self, from: Data(#"{"id":"w","path":"/tmp/ws"}"#.utf8))
        #expect(w.path == "/tmp/ws")
    }
}
