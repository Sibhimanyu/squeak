import Foundation

// The Artifacts tab (right zone, beside Pond and Code): what a pond's ducks made for the person to look at. The host
// lists them (`GET /native/projects/<id>/artifacts`); this is the decoding and the pure rules the view draws from:
// kind from a file's extension, the grouping by duck, which preview a kind gets and what "Open" is called.

/// What a file is, for its icon, its preview and the app that opens it.
public enum ArtifactKind: String, Sendable, CaseIterable {
    case page, doc, slides, image, pdf, psd, ai, svg, video, audio, other

    /// The host's word, or `other` for one this build does not know.
    public init(wire: String?) { self = wire.flatMap(ArtifactKind.init(rawValue:)) ?? .other }

    /// From a file name, the same table the host uses (`artifactKindFromPath`).
    public init(path: String) {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm", "md", "markdown", "mdx": self = .page
        case "pdf": self = .pdf
        case "psd": self = .psd
        case "ai": self = .ai
        case "svg": self = .svg
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tif", "tiff": self = .image
        case "pptx", "ppt", "key": self = .slides
        case "txt", "rtf", "doc", "docx", "pages", "xlsx", "numbers", "csv": self = .doc
        case "mp4", "mov", "m4v": self = .video
        case "m4a", "mp3", "wav", "aac": self = .audio
        default: self = .other
        }
    }
}

public struct ArtifactItem: Decodable, Sendable, Equatable, Identifiable {
    public var path: String
    public var name: String
    public var kind: ArtifactKind
    public var duckId: String?
    public var duckName: String?
    public var branch: String?
    /// A duck showed it (`show`) rather than it being found in a folder.
    public var shown: Bool
    public var modifiedAt: Date
    public var size: Int64

    public var id: String { path }

    public init(
        path: String, name: String? = nil, kind: ArtifactKind? = nil, duckId: String? = nil, duckName: String? = nil,
        branch: String? = nil, shown: Bool = false, modifiedAt: Date = Date(), size: Int64 = 0
    ) {
        self.path = path
        self.name = name ?? (path as NSString).lastPathComponent
        self.kind = kind ?? ArtifactKind(path: path)
        self.duckId = duckId; self.duckName = duckName; self.branch = branch
        self.shown = shown; self.modifiedAt = modifiedAt; self.size = size
    }

    private enum CodingKeys: String, CodingKey { case path, name, kind, duckId, duckName, branch, source, modifiedAt, size }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        name = c.lenient(String.self, .name) ?? (path as NSString).lastPathComponent
        kind = c.lenient(String.self, .kind).map { ArtifactKind(wire: $0) } ?? ArtifactKind(path: path)
        duckId = c.lenient(String.self, .duckId)
        duckName = c.lenient(String.self, .duckName)
        branch = c.lenient(String.self, .branch)
        shown = c.lenient(String.self, .source) == "shown"
        modifiedAt = Date(timeIntervalSince1970: (c.lenient(Double.self, .modifiedAt) ?? 0) / 1000)
        size = c.lenient(Int64.self, .size) ?? 0
    }
}

struct ArtifactList: Decodable {
    var artifacts: [Failable<ArtifactItem>]
}

extension NativeHostClient {
    /// A pond's artifacts, newest first. An older host without the route answers 404: the caller shows an empty list.
    public func artifacts(projectId: String) async throws -> [ArtifactItem] {
        let data = try await call("GET", "/native/projects/\(Self.id(projectId))/artifacts", timeout: 15)
        return try JSONDecoder.native(ArtifactList.self, data).artifacts.compactMap(\.value)
    }
}

/// One duck's artifacts, newest first.
public struct ArtifactGroup: Equatable, Sendable, Identifiable {
    public var id: String
    /// "Pip", or "Main" for files no duck owns.
    public var title: String
    public var items: [ArtifactItem]
}

public enum Artifacts {
    /// Grouped by duck, the group with the newest file first; inside a group newest first. Files with no duck go in one
    /// "Main" group. A duck is its id when the host gave one, else its name.
    public static func grouped(_ items: [ArtifactItem]) -> [ArtifactGroup] {
        var order: [String] = []
        var buckets: [String: [ArtifactItem]] = [:]
        var titles: [String: String] = [:]
        for item in items.sorted(by: newestFirst) {
            let key = item.duckId ?? item.duckName.map { "name:\($0)" } ?? ""
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(item)
            if titles[key] == nil || (titles[key] == mainTitle && item.duckName != nil) { titles[key] = item.duckName ?? mainTitle }
        }
        return order.map { ArtifactGroup(id: $0.isEmpty ? "main" : $0, title: titles[$0] ?? mainTitle, items: buckets[$0] ?? []) }
    }

    public static let mainTitle = "Main"

    /// The search over a list: every word of `query` must appear (case-insensitive) in the name, path, duck, branch or
    /// kind (its id or its title, so "photoshop" finds a .psd). An empty query keeps everything.
    public static func filter(_ items: [ArtifactItem], query: String) -> [ArtifactItem] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return items }
        return items.filter { item in
            let hay = [item.name, item.path, item.duckName ?? "", item.branch ?? "", item.kind.rawValue, kindTitle(item.kind)]
                .joined(separator: "\n").lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// The line under the search field when nothing matches.
    public static func noMatch(_ query: String) -> String {
        "No artifacts match \u{201C}\(query.trimmingCharacters(in: .whitespaces))\u{201D}."
    }

    static func newestFirst(_ a: ArtifactItem, _ b: ArtifactItem) -> Bool {
        a.modifiedAt != b.modifiedAt ? a.modifiedAt > b.modifiedAt : a.path < b.path
    }

    /// "Pip · feature/x · 3h" under a row's name; the branch only when there is one.
    public static func meta(_ item: ArtifactItem, now: Date = Date()) -> String {
        var parts: [String] = []
        if let d = item.duckName, !d.isEmpty { parts.append(d) }
        if let b = item.branch, !b.isEmpty { parts.append(b) }
        parts.append(PickerRows.age(item.modifiedAt, now: now))
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The app a design file belongs in, for the "Open in ..." label when the system names no app; nil = just "Open".
    public static func openAppName(_ kind: ArtifactKind) -> String? {
        switch kind {
        case .psd: "Photoshop"
        case .ai: "Illustrator"
        default: nil
        }
    }

    public static func openLabel(_ kind: ArtifactKind) -> String { openAppName(kind).map { "Open in \($0)" } ?? "Open" }

    /// The viewer's "open" button: named after the app the system opens the file with ("Keynote", "Photoshop"); with
    /// none known it asks which app ("Open with...").
    public static func openLabel(kind: ArtifactKind, systemApp: String?) -> String {
        if let app = systemApp?.trimmingCharacters(in: .whitespaces), !app.isEmpty { return "Open in \(app)" }
        return "Open with\u{2026}"
    }

    /// The viewer header's line under the name: "Pip · feature/x · Slides · 12 slides · 1.4 MB".
    public static func viewerMeta(_ item: ArtifactItem, extras: [String] = []) -> String {
        var parts: [String] = []
        if let d = item.duckName, !d.isEmpty { parts.append(d) }
        if let b = item.branch, !b.isEmpty { parts.append(b) }
        parts.append(kindTitle(item.kind))
        parts += extras.filter { !$0.isEmpty }
        if item.size > 0 { parts.append(sizeText(item.size)) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// "1.4 MB" style size for the viewer header.
    public static func sizeText(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    /// The word for a kind in the viewer header.
    public static func kindTitle(_ kind: ArtifactKind) -> String {
        switch kind {
        case .page: "Page"
        case .doc: "Document"
        case .slides: "Slides"
        case .image: "Image"
        case .pdf: "PDF"
        case .psd: "Photoshop file"
        case .ai: "Illustrator file"
        case .svg: "SVG"
        case .video: "Video"
        case .audio: "Audio"
        case .other: "File"
        }
    }
}

/// Counts the slides of a PowerPoint file from the names inside its zip (`ppt/slides/slide1.xml` ...).
public enum SlideCount {
    public static func pptx(entries: [String]) -> Int? {
        let n = entries.filter { name in
            guard name.hasPrefix("ppt/slides/slide"), name.hasSuffix(".xml") else { return false }
            let digits = name.dropFirst("ppt/slides/slide".count).dropLast(".xml".count)
            return !digits.isEmpty && digits.allSatisfy(\.isNumber)
        }.count
        return n > 0 ? n : nil
    }
}

/// Which viewer draws an artifact, from its file's extension alone (pure; the view does the loading).
public enum ArtifactPreview: Equatable, Sendable {
    /// An HTML page or slide deck: a web view with read access to its folder.
    case web
    /// Markdown, drawn by the markdown page renderer.
    case markdown
    /// A PDF: PDFKit with a page sidebar.
    case pdf
    /// Illustrator: PDFKit when the file carries a PDF, else a large thumbnail and "Open in Illustrator".
    case illustrator
    /// A picture ImageIO reads: PNG, JPEG, GIF, WebP, TIFF, HEIC, and a flattened Photoshop file.
    case image
    /// SVG, drawn by a web view and zoomable.
    case svg
    /// Quick Look draws it with its own page and slide navigation: Office, iWork, RTF, spreadsheets.
    case quickLook
    /// AVKit: video and audio.
    case media
    /// Nothing above knows it: Quick Look first, then the file's icon with Open and Reveal.
    case other

    public static func kind(for path: String) -> ArtifactPreview {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": .web
        case "md", "markdown", "mdx": .markdown
        case "pdf": .pdf
        case "ai": .illustrator
        case "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif", "psd": .image
        case "svg": .svg
        case "pptx", "ppt", "key", "docx", "doc", "xlsx", "xls", "pages", "numbers", "rtf", "csv", "txt": .quickLook
        case "mp4", "mov", "m4v", "m4a", "mp3", "wav", "aac": .media
        default: .other
        }
    }

    /// Where a viewer that could not draw the file ends up: a picture or PDF falls to Quick Look; Illustrator, Quick
    /// Look and the rest have nowhere further (the icon with Open and Reveal).
    public static func fallback(after preview: ArtifactPreview) -> ArtifactPreview? {
        switch preview {
        case .pdf, .image, .svg, .media, .web, .markdown: .quickLook
        case .illustrator, .quickLook, .other: nil
        }
    }

    /// Zoom steps shared by the image and SVG viewers: fit, then 25% to 800%.
    public static let zoomRange: ClosedRange<Double> = 0.1...8
    public static func zoomed(_ z: Double, in zoomIn: Bool) -> Double {
        min(max(zoomIn ? z * 1.25 : z / 1.25, zoomRange.lowerBound), zoomRange.upperBound)
    }
}
