import Foundation

// The Artifacts tab (right zone, beside Pond and Code): what a pond's ducks made for the person to look at. The host
// lists them (`GET /native/projects/<id>/artifacts`); this is the decoding and the pure rules the view draws from:
// kind from a file's extension, the grouping by duck, which preview a kind gets and what "Open" is called.

/// What a file is, for its icon, its preview and the app that opens it.
public enum ArtifactKind: String, Sendable, CaseIterable {
    case page, doc, image, pdf, psd, ai, svg, other

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
        case "txt", "rtf", "doc", "docx": self = .doc
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

    /// The app a design file belongs in, for the "Open in ..." label; nil = just "Open".
    public static func openAppName(_ kind: ArtifactKind) -> String? {
        switch kind {
        case .psd: "Photoshop"
        case .ai: "Illustrator"
        default: nil
        }
    }

    public static func openLabel(_ kind: ArtifactKind) -> String { openAppName(kind).map { "Open in \($0)" } ?? "Open" }
}

/// How an artifact is shown in the tab.
public enum ArtifactPreview: Equatable, Sendable {
    /// An HTML page, drawn as a page.
    case web
    /// Markdown, drawn as a page by the file tab's Markdown preview.
    case markdown
    /// A picture (PNG, JPEG, GIF, WebP, SVG): the file tab's image viewer.
    case image
    /// A PDF, or an Illustrator file saved with PDF compatibility (it is a PDF inside).
    case pdf
    /// Quick Look draws it: a Photoshop file (macOS flattens it), a document, anything else.
    case quickLook

    public static func choose(kind: ArtifactKind, path: String) -> ArtifactPreview {
        switch kind {
        case .page:
            let ext = (path as NSString).pathExtension.lowercased()
            return ext == "html" || ext == "htm" ? .web : .markdown
        case .image, .svg: return .image
        case .pdf, .ai: return .pdf
        case .psd, .doc, .other: return .quickLook
        }
    }

    /// Where a preview that could not be drawn ends up: an Illustrator file with no PDF inside shows its icon and
    /// "Open in Illustrator"; any other falls to Quick Look, then its icon.
    public static func fallback(after preview: ArtifactPreview, kind: ArtifactKind) -> ArtifactPreview? {
        switch (preview, kind) {
        case (.pdf, .ai): nil
        case (.pdf, _), (.image, _): .quickLook
        default: nil
        }
    }
}
