import CoreGraphics
import Foundation

// Attachments in the pond room. The format is a chat message's: pictures are PNG or JPEG at the chat composer's limits
// (`ImageAttachments`), other files travel as they are. The host stores them with the post and, when the message becomes
// work for a duck, writes them under the duck's folder (`.context/attachments/<id>/`) the way a chat's are.

public enum RoomAttachmentKind: String, Sendable, Equatable { case image, file }

/// An attachment of a post, as the host lists it. `url` is a path on the host (token-gated).
public struct RoomAttachment: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    public var kind: RoomAttachmentKind
    public var name: String
    public var mime: String
    public var size: Int
    public var url: String
    /// A picture's own size in pixels (the host reads it from the header), so its frame is known before it loads.
    public var width: Int?
    public var height: Int?

    public init(
        id: String, kind: RoomAttachmentKind, name: String, mime: String = "", size: Int = 0, url: String = "",
        width: Int? = nil, height: Int? = nil
    ) {
        self.id = id; self.kind = kind; self.name = name; self.mime = mime; self.size = size; self.url = url
        self.width = width; self.height = height
    }

    private enum CodingKeys: String, CodingKey { case id, kind, name, mime, size, url, width, height }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decode(String.self, forKey: .kind)).flatMap(RoomAttachmentKind.init(rawValue:)) ?? .file
        name = (try? c.decode(String.self, forKey: .name)) ?? "file"
        mime = (try? c.decode(String.self, forKey: .mime)) ?? ""
        size = (try? c.decode(Int.self, forKey: .size)) ?? 0
        url = (try? c.decode(String.self, forKey: .url)) ?? ""
        width = try? c.decode(Int.self, forKey: .width)
        height = try? c.decode(Int.self, forKey: .height)
    }

    public var pixelSize: CGSize? {
        guard let width, let height, width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }

    /// A picture or file still being sent: shown at once, without a host address.
    public var isLocal: Bool { url.isEmpty }
}

public enum RoomAttachmentLimits {
    public static let maxImages = ImageAttachments.maxImages
    public static let maxFiles = 4
    /// One file (a picture is made small by `ImageAttachments.prepare` first).
    public static let maxFileBytes = 5_000_000
    /// The whole message; the host refuses more.
    public static let maxTotalBytes = 16_000_000

    /// Why a file cannot be attached, or nil. Pictures go through `ImageAttachments.prepare`; this is for the rest.
    public static func fileProblem(name: String, size: Int) -> String? {
        if size <= 0 { return "\u{201C}\(name)\u{201D} is empty." }
        if size > maxFileBytes { return "\u{201C}\(name)\u{201D} is over 5 MB." }
        return nil
    }
}

/// One thing waiting to go with the next room message.
public struct OutgoingAttachment: Sendable, Equatable, Identifiable {
    public let id: UUID
    public var kind: RoomAttachmentKind
    public var name: String
    /// A picture: the prepared PNG or JPEG bytes. A file: its bytes.
    public var data: Data
    public var width: Int?
    public var height: Int?
    public init(id: UUID = UUID(), kind: RoomAttachmentKind, name: String, data: Data, width: Int? = nil, height: Int? = nil) {
        self.id = id; self.kind = kind; self.name = name; self.data = data; self.width = width; self.height = height
    }

    /// The post's view of it while it is sent (no host address yet).
    public var placeholder: RoomAttachment {
        RoomAttachment(id: "local-" + id.uuidString, kind: kind, name: name, mime: "", size: data.count, url: "", width: width, height: height)
    }
}

/// The attachments of one room composer: pure state, drawn by the Mac's tray. Nothing is written to disk here.
public struct RoomAttachmentDraft: Sendable, Equatable {
    public private(set) var items: [OutgoingAttachment] = []
    /// Pictures being read and shrunk (they count toward the limit already).
    public private(set) var preparing = 0
    /// One inline sentence under the thumbnails; cleared by the next successful change.
    public private(set) var error: String?

    public init() {}

    public var images: [OutgoingAttachment] { items.filter { $0.kind == .image } }
    public var files: [OutgoingAttachment] { items.filter { $0.kind == .file } }
    public var isEmpty: Bool { items.isEmpty && preparing == 0 }
    public var totalBytes: Int { items.reduce(0) { $0 + $1.data.count } }
    public func isFull(_ kind: RoomAttachmentKind) -> Bool {
        switch kind {
        case .image: images.count + preparing >= RoomAttachmentLimits.maxImages
        case .file: files.count >= RoomAttachmentLimits.maxFiles
        }
    }

    /// Reserves a place for a picture about to be prepared; false (with the reason) when there is none or it is frozen.
    public mutating func beginImage() -> Bool {
        guard !isFull(.image) else { error = "Up to \(RoomAttachmentLimits.maxImages) images per message."; return false }
        error = nil
        preparing += 1
        return true
    }

    /// The picture is ready, or (nil) could not be read.
    public mutating func finishImage(_ prepared: PreparedImage?, name: String, size: CGSize? = nil) {
        preparing = max(0, preparing - 1)
        guard let prepared else { error = "Squeak can only attach images it can read (PNG, JPEG, HEIC, TIFF, GIF)."; return }
        append(OutgoingAttachment(kind: .image, name: name, data: prepared.data, width: size.map { Int($0.width) }, height: size.map { Int($0.height) }))
    }

    public mutating func addFile(name: String, data: Data) {
        if isFull(.file) { error = "Up to \(RoomAttachmentLimits.maxFiles) files per message."; return }
        if let problem = RoomAttachmentLimits.fileProblem(name: name, size: data.count) { error = problem; return }
        append(OutgoingAttachment(kind: .file, name: name, data: data))
    }

    private mutating func append(_ item: OutgoingAttachment) {
        if totalBytes + item.data.count > RoomAttachmentLimits.maxTotalBytes { error = "Attachments are over 16 MB together."; return }
        error = nil
        items.append(item)
    }

    public mutating func fail(_ message: String) { error = message }
    public mutating func remove(_ id: UUID) { items.removeAll { $0.id == id }; error = nil }
    public mutating func clear() { items = []; error = nil }

    /// Words, or something attached, and nothing still being prepared.
    public func canSend(text: String) -> Bool {
        guard preparing == 0 else { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !items.isEmpty
    }

    /// The body's `attachments`: `[{ name, data }]`, data base64 (the host decides picture or file by the bytes).
    public static func wire(_ items: [OutgoingAttachment]) -> NativeJSON {
        .array(items.map { .object(["name": .string($0.name), "data": .string($0.data.base64EncodedString())]) })
    }
}

/// How a message's pictures sit in its bubble: one picture keeps its shape up to 240 pt either way; two or more go in a
/// two-column grid of equal tiles (cropped to fill), so a row never depends on whether a picture has loaded.
public enum RoomAttachmentGrid {
    public static let maxWidth: CGFloat = 240
    public static let spacing: CGFloat = 4

    public static func columns(count: Int) -> Int { count <= 1 ? 1 : 2 }
    public static func rows(count: Int) -> Int { count <= 0 ? 0 : (count + columns(count: count) - 1) / columns(count: count) }

    /// Each picture's frame size (`naturals` are the pictures' own sizes when known).
    public static func sizes(naturals: [CGSize?]) -> [CGSize] {
        guard !naturals.isEmpty else { return [] }
        if naturals.count == 1 { return [PictureLayout.size(image: naturals[0], maxWidth: maxWidth, maxHeight: maxWidth)] }
        let side = ((maxWidth - spacing) / 2).rounded(.down)
        return naturals.map { _ in CGSize(width: side, height: side) }
    }
}

public enum RoomAttachmentText {
    /// "420 KB", "1.2 MB".
    public static func size(_ bytes: Int) -> String {
        if bytes < 1000 { return "\(bytes) B" }
        if bytes < 1_000_000 { return "\(Int((Double(bytes) / 1000).rounded())) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1_000_000)
    }

    /// The accessibility label of a picture or file.
    public static func label(_ a: RoomAttachment) -> String {
        a.kind == .image ? "Image, \(a.name)" : "File, \(a.name), \(size(a.size))"
    }
}

/// A message to a duck that carries files: the pictures through `ImageAttachments`, the files saved beside them, and each
/// file named on a line `Attached file: <path>` (the host's own wording for a job's files).
public enum RoomAttachmentFiles {
    public static func line(for ref: String) -> String { "Attached file: \(ref)" }

    /// The text to send: the person's words, the picture tokens, then one line per saved file.
    public static func compose(_ text: String, imageRefs: [String], fileRefs: [String]) -> String {
        var out = ImageAttachments.compose(text, refs: imageRefs)
        if imageRefs.isEmpty, out.isEmpty { out = fileRefs.count == 1 ? "See the attached file." : "See the attached files." }
        guard !fileRefs.isEmpty else { return out }
        return ([out, ""] + fileRefs.map(line(for:))).joined(separator: "\n")
    }

    /// A file name safe to write: its last path part, no control characters, no leading dot, at most 80 characters.
    public static func cleanName(_ raw: String) -> String {
        let last = raw.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var name = String(last.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f })
        while name.hasPrefix(".") { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "file" }
        guard name.count > 80 else { return name }
        let ext = (name as NSString).pathExtension
        return String(name.prefix(80 - (ext.isEmpty ? 0 : ext.count + 1))) + (ext.isEmpty ? "" : "." + ext)
    }

    /// Writes `files` into one new folder under `dir`'s `.context/attachments/` (never through a symlink, never
    /// overwriting) and returns each path relative to `dir`. All or nothing.
    public static func save(_ files: [(name: String, data: Data)], into dir: String, fileManager fm: FileManager = .default) throws -> [String] {
        guard !files.isEmpty else { return [] }
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
            let folder = attachments.appendingPathComponent(ImageAttachments.randomID())
            try fm.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            guard folder.resolvingSymlinksInPath().path.hasPrefix(root.path + "/") else {
                try? fm.removeItem(at: folder)
                throw ImageAttachmentError.folderUnsafe
            }
            var refs: [String] = [], used = Set<String>()
            do {
                for file in files {
                    var name = cleanName(file.name)
                    if used.contains(name) { name = "\(used.count + 1)-\(name)" }
                    used.insert(name)
                    let target = folder.appendingPathComponent(name)
                    try file.data.write(to: target, options: .withoutOverwriting)
                    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
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
}
