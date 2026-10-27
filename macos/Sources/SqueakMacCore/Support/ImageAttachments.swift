import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// An image ready to be written next to a chat: re-encoded as PNG (or JPEG when PNG is too heavy), shrunk to
/// `ImageAttachments.longestEdge`, with metadata dropped.
public struct PreparedImage: Sendable, Equatable {
    public let data: Data
    /// `png` or `jpg`.
    public let ext: String
    public init(data: Data, ext: String) { self.data = data; self.ext = ext }
}

public enum ImageAttachmentError: Error, Equatable, LocalizedError {
    case folderMissing, folderUnsafe, notAnImage, failed

    public var errorDescription: String? {
        switch self {
        case .folderMissing: "That chat's folder isn't there, so the image can't be saved."
        case .folderUnsafe: "That chat's folder isn't safe to write to."
        case .notAnImage: "That isn't an image Squeak can attach."
        case .failed: "Squeak couldn't save the image."
        }
    }
}

/// Images attached from the Mac. It does what the phone's photos do and what Conductor itself does: the image
/// is saved under the chat's folder in `.context/attachments/<id>/image-N.<ext>` and the message names each
/// path on its own `[Image: …]` line, which the agent reads. The same limits as the phone's photos
/// (`PhotoAttachment` in SqueakCore on iOS): four images, 1600 px on the long edge, 1.2 MB each.
public enum ImageAttachments {
    public static let maxImages = 4
    public static let longestEdge = 1600
    public static let maxBytes = 1_200_000
    /// The most a source file may weigh before it is even decoded.
    public static let maxSourceBytes = 40_000_000

    // MARK: Message wording (the phone's, character for character)

    public static func line(for ref: String) -> String { "[Image: \(ref)]" }

    /// What is sent: the person's words, then one line per saved image. With no words, a plain request to look.
    public static func compose(_ text: String, refs: [String]) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !refs.isEmpty else { return words }
        let lead = words.isEmpty ? (refs.count == 1 ? "See the attached image." : "See the attached images.") : words
        return ([lead, ""] + refs.map(line(for:))).joined(separator: "\n")
    }

    // MARK: Preparing

    /// `png` or `jpg` by the bytes themselves, never by a name.
    public static func kind(of data: Data) -> String? {
        let b = [UInt8](data.prefix(8))
        if b.count >= 3, b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { return "jpg" }
        if b == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] { return "png" }
        return nil
    }

    /// Any image macOS can decode (PNG, JPEG, HEIC, TIFF, GIF, …) as a PNG at most `longestEdge` on its long
    /// edge, or a JPEG when the PNG would pass `maxBytes`. Nil for anything that is not an image or will not
    /// get small enough.
    public static func prepare(_ source: Data) -> PreparedImage? {
        guard !source.isEmpty, source.count <= maxSourceBytes,
              let src = CGImageSourceCreateWithData(source as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(src) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int,
              w > 0, h > 0
        else { return nil }
        let start = min(longestEdge, max(w, h))
        for edge in [start, start * 3 / 4, start / 2].filter({ $0 >= 64 || $0 == start }) {
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: edge,
            ]
            guard let image = CGImageSourceCreateThumbnailAtIndex(src, 0, options as CFDictionary) else { return nil }
            if let png = encode(image, type: .png, quality: nil), png.count <= maxBytes { return PreparedImage(data: png, ext: "png") }
            let flat = flatten(image) ?? image
            for q in [0.85, 0.7, 0.55, 0.4] as [Double] {
                if let jpeg = encode(flat, type: .jpeg, quality: q), jpeg.count <= maxBytes { return PreparedImage(data: jpeg, ext: "jpg") }
            }
        }
        return nil
    }

    private static func encode(_ image: CGImage, type: UTType, quality: Double?) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
        var props: [CFString: Any] = [:]
        if let quality { props[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    /// A JPEG has no transparency: put the image on white first, so a transparent PNG is not drawn black.
    private static func flatten(_ image: CGImage) -> CGImage? {
        guard let ctx = CGContext(
            data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return ctx.makeImage()
    }

    // MARK: Saving

    /// Writes `images` into one new folder under `dir`'s `.context/attachments/` and returns each path relative
    /// to `dir` (what the message names). All or nothing: a failure removes what this call made. Never
    /// overwrites, never follows a symlink planted as `.context` or `attachments`, and the bytes must really
    /// be a PNG or JPEG whatever the name says.
    public static func save(
        _ images: [PreparedImage], into dir: String, fileManager fm: FileManager = .default,
        makeID: () -> String = randomID
    ) throws -> [String] {
        guard !images.isEmpty else { return [] }
        guard images.allSatisfy({ kind(of: $0.data) == $0.ext }) else { throw ImageAttachmentError.notAnImage }
        let root = URL(fileURLWithPath: dir).resolvingSymlinksInPath()
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: root.path, isDirectory: &isDir), isDir.boolValue else { throw ImageAttachmentError.folderMissing }
        let context = root.appendingPathComponent(".context"), attachments = context.appendingPathComponent("attachments")
        for part in [context, attachments] {
            if let type = try? fm.attributesOfItem(atPath: part.path)[.type] as? FileAttributeType, type == .typeSymbolicLink {
                throw ImageAttachmentError.folderUnsafe
            }
        }
        do {
            try fm.createDirectory(at: attachments, withIntermediateDirectories: true)
            var folder: URL?
            for _ in 0..<8 {
                let candidate = attachments.appendingPathComponent(makeID())
                do {
                    try fm.createDirectory(at: candidate, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
                    folder = candidate
                    break
                } catch CocoaError.fileWriteFileExists { continue }
            }
            guard let folder else { throw ImageAttachmentError.failed }
            guard folder.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else {
                try? fm.removeItem(at: folder)
                throw ImageAttachmentError.folderUnsafe
            }
            var refs: [String] = []
            do {
                for (i, image) in images.enumerated() {
                    let name = "image-\(i + 1).\(image.ext)"
                    let file = folder.appendingPathComponent(name)
                    try image.data.write(to: file, options: .withoutOverwriting)
                    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                    refs.append(".context/attachments/\(folder.lastPathComponent)/\(name)")
                }
            } catch {
                try? fm.removeItem(at: folder)
                throw error
            }
            return refs
        } catch let e as ImageAttachmentError {
            throw e
        } catch {
            throw ImageAttachmentError.failed
        }
    }

    public static func randomID() -> String {
        (0..<4).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }
}
