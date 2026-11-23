import CoreGraphics
import Foundation

// Canvases (phase 1): a pond's `canvases/<slug>.canvas/` folders of artboards (self-contained HTML). The host lists,
// creates and streams them (`src/native/canvases.ts`); this is the decoding and the pure rules the views draw from:
// the kinds and their menu words, which artboards need drawing again after a change, export file names, and the
// words on the pond page. Nothing here touches WebKit or the disk.

public enum CanvasKind: String, Sendable, CaseIterable, Equatable {
    case deck, poster, logo, social, blank

    public init(wire: String?) { self = wire.flatMap(CanvasKind.init(rawValue:)) ?? .blank }

    /// The "+ New canvas" menu word.
    public var menuTitle: String {
        switch self {
        case .deck: "Deck"
        case .poster: "Poster"
        case .logo: "Logo sheet"
        case .social: "Social post"
        case .blank: "Blank"
        }
    }

    /// The name a new canvas of this kind starts with.
    public var defaultTitle: String {
        switch self {
        case .deck: "Untitled deck"
        case .poster: "Untitled poster"
        case .logo: "Untitled logo sheet"
        case .social: "Untitled social post"
        case .blank: "Untitled canvas"
        }
    }
}

public struct CanvasSummary: Decodable, Sendable, Equatable, Identifiable {
    public var path: String
    public var title: String
    public var kind: CanvasKind
    public var artboards: Int
    public var modifiedAt: Date
    public var duckName: String?
    public var branch: String?
    public var id: String { path }

    public init(path: String, title: String, kind: CanvasKind = .blank, artboards: Int = 1, modifiedAt: Date = Date(), duckName: String? = nil, branch: String? = nil) {
        self.path = path; self.title = title; self.kind = kind; self.artboards = artboards
        self.modifiedAt = modifiedAt; self.duckName = duckName; self.branch = branch
    }

    private enum CodingKeys: String, CodingKey { case path, title, kind, artboards, modifiedAt, duckName, branch }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        title = c.lenient(String.self, .title) ?? ((path as NSString).lastPathComponent as NSString).deletingPathExtension
        kind = CanvasKind(wire: c.lenient(String.self, .kind))
        artboards = c.lenient(Int.self, .artboards) ?? 0
        modifiedAt = Date(timeIntervalSince1970: (c.lenient(Double.self, .modifiedAt) ?? 0) / 1000)
        duckName = c.lenient(String.self, .duckName)
        branch = c.lenient(String.self, .branch)
    }
}

/// One artboard as the host reads it: its size and the HTML file that draws it.
public struct CanvasArtboardInfo: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var width: Double
    public var height: Double
    public var background: String?
    /// Absolute path of the artboard's HTML.
    public var file: String
    public var modifiedAt: Int64

    public var size: CGSize { CGSize(width: width, height: height) }

    public init(id: String, name: String, width: Double, height: Double, background: String? = nil, file: String = "", modifiedAt: Int64 = 0) {
        self.id = id; self.name = name; self.width = width; self.height = height
        self.background = background; self.file = file; self.modifiedAt = modifiedAt
    }
}

public struct CanvasDetail: Decodable, Sendable, Equatable {
    public var path: String
    public var title: String
    public var kind: CanvasKind
    public var artboards: [CanvasArtboardInfo]
    public var assetsModifiedAt: Int64

    public init(path: String, title: String, kind: CanvasKind = .blank, artboards: [CanvasArtboardInfo], assetsModifiedAt: Int64 = 0) {
        self.path = path; self.title = title; self.kind = kind; self.artboards = artboards; self.assetsModifiedAt = assetsModifiedAt
    }

    private enum CodingKeys: String, CodingKey { case path, canvas, artboards, assetsModifiedAt }
    private struct Doc: Decodable { var title: String; var kind: String? }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        let doc = try c.decode(Doc.self, forKey: .canvas)
        title = doc.title
        kind = CanvasKind(wire: doc.kind)
        artboards = try c.decode([CanvasArtboardInfo].self, forKey: .artboards)
        assetsModifiedAt = c.lenient(Int64.self, .assetsModifiedAt) ?? 0
    }
}

private struct CanvasList: Decodable { var canvases: [Failable<CanvasSummary>] }
private struct CanvasCreated: Decodable { var canvas: CanvasSummary }

public enum CanvasStreamEvent: Sendable, Equatable {
    /// Something in the canvas folder changed: read it again.
    case changed
    /// The stream (re)connected: read once, in case something happened while it was down.
    case connected
}

extension NativeHostClient {
    /// A pond's canvases, newest first. A host without the route answers 404: the caller shows an empty list.
    public func canvases(projectId: String) async throws -> [CanvasSummary] {
        let data = try await call("GET", "/native/projects/\(Self.id(projectId))/canvases", timeout: 15)
        return try JSONDecoder.native(CanvasList.self, data).canvases.compactMap(\.value)
    }

    /// Makes a canvas of `kind` in the pond's main folder; returns its row.
    public func createCanvas(projectId: String, title: String, kind: CanvasKind) async throws -> CanvasSummary {
        let body: NativeJSON = .object(["title": .string(title), "kind": .string(kind.rawValue)])
        let data = try await call("POST", "/native/projects/\(Self.id(projectId))/canvases", body: body, timeout: 15)
        return try JSONDecoder.native(CanvasCreated.self, data).canvas
    }

    public func canvasDetail(path: String) async throws -> CanvasDetail {
        let data = try await call("GET", "/native/canvases?path=\(Self.id(path))", timeout: 15)
        return try JSONDecoder.native(CanvasDetail.self, data)
    }

    /// `GET /native/canvases/stream?path=`: `connected` on every (re)connect, `changed` per debounced change.
    public func canvasEvents(
        path: String, minBackoff: Duration = .seconds(1), maxBackoff: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> AsyncStream<CanvasStreamEvent> {
        let host = self
        return AsyncStream { continuation in
            let task = Task {
                var backoff = minBackoff
                while !Task.isCancelled {
                    guard let token = host.tokenProvider() else { try? await sleep(maxBackoff); continue }
                    let request = HTTPRequest(url: host.url("/native/canvases/stream?path=\(Self.id(path))"), headers: ["x-squeak-token": token], timeout: 90)
                    var parser = SSEParser()
                    var absent = false
                    do {
                        for try await line in host.lineSource(request) {
                            guard let frame = parser.feed(line) else { continue }
                            backoff = minBackoff
                            switch frame.event {
                            case "hello": continuation.yield(.connected)
                            case "changed": continuation.yield(.changed)
                            default: break
                            }
                        }
                    } catch where PondsClient.isAbsent(error) {
                        absent = true
                    } catch {}
                    if Task.isCancelled || absent { break }
                    try? await sleep(backoff)
                    backoff = min(maxBackoff, backoff * 2)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: Pure rules

public enum CanvasBoards {
    /// What a drawn artboard was drawn from. Equal stamps mean the picture is still right.
    public struct Stamp: Equatable, Sendable {
        public var modifiedAt: Int64
        public var width: Double
        public var height: Double
        public var background: String?
        public var assetsModifiedAt: Int64
        public init(_ board: CanvasArtboardInfo, assetsModifiedAt: Int64) {
            modifiedAt = board.modifiedAt; width = board.width; height = board.height
            background = board.background; self.assetsModifiedAt = assetsModifiedAt
        }
    }

    /// The ids to draw (again): artboards never drawn, and those whose file, size, background or the canvas's assets
    /// changed since. Boards whose stamp is unchanged are left alone, so a duck editing slide 4 redraws only slide 4.
    public static func needingRender(drawn: [String: Stamp], detail: CanvasDetail) -> [String] {
        detail.artboards.filter { drawn[$0.id] != Stamp($0, assetsModifiedAt: detail.assetsModifiedAt) }.map(\.id)
    }

    /// The drawn pictures worth keeping after a change: only artboards the canvas still has.
    public static func pruned(drawn: [String: Stamp], detail: CanvasDetail) -> [String: Stamp] {
        let ids = Set(detail.artboards.map(\.id))
        return drawn.filter { ids.contains($0.key) }
    }

    /// "1 artboard" / "6 artboards".
    public static func countText(_ n: Int) -> String { n == 1 ? "1 artboard" : "\(n) artboards" }

    /// "Deck · 6 artboards · 3h" on the pond page.
    public static func meta(_ c: CanvasSummary, now: Date = Date()) -> String {
        [c.kind.menuTitle, countText(c.artboards), PickerRows.age(c.modifiedAt, now: now)].joined(separator: " \u{00B7} ")
    }

    /// The composer text "Ask a duck..." leaves, ready for the person to finish.
    public static func askPrefill(title: String) -> String { "In canvas \(title), " }

    /// The artboard index that clicking a list row scrolls to; nil when out of range.
    public static func frame(at index: Int, in frames: [CGRect]) -> CGRect? { frames.indices.contains(index) ? frames[index] : nil }
}

public enum CanvasExport {
    public enum Scale: Int, Sendable, CaseIterable { case one = 1, two = 2
        public var suffix: String { self == .one ? "" : "@2x" }
        public var menuTitle: String { self == .one ? "PNG at 1x" : "PNG at 2x" }
    }

    /// A file-name-safe word: letters, digits, dashes and underscores; never empty.
    public static func safe(_ s: String, fallback: String = "canvas") -> String {
        let mapped = s.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
        let flat = String(mapped).split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return flat.isEmpty ? fallback : String(flat.prefix(60))
    }

    /// The PDF's name: "Pitch.pdf".
    public static func pdfName(canvas: String) -> String { "\(safe(canvas)).pdf" }

    /// One PNG's name: "Pitch-02-Agenda@2x.png". The number keeps the order and makes equal names differ.
    public static func pngName(canvas: String, board: String, index: Int, count: Int, scale: Scale) -> String {
        let width = max(2, String(count).count)
        let n = String(format: "%0\(width)d", index + 1)
        return "\(safe(canvas))-\(n)-\(safe(board, fallback: "artboard"))\(scale.suffix).png"
    }

    /// "Exporting 2 of 6\u{2026}".
    public static func progressText(done: Int, total: Int) -> String { "Exporting \(min(done + 1, max(total, 1))) of \(total)\u{2026}" }

    /// The folder's name for a batch of PNGs, next to the chosen place: "Pitch-png".
    public static func folderName(canvas: String) -> String { "\(safe(canvas))-png" }

    /// Which artboards a PNG export covers: the selected one, or all.
    public static func targets(all: Bool, selected: Int, count: Int) -> [Int] {
        guard count > 0 else { return [] }
        return all ? Array(0..<count) : [min(max(selected, 0), count - 1)]
    }

    /// Pixel size of an artboard's picture at a scale.
    public static func pixelSize(_ size: CGSize, scale: Scale) -> CGSize {
        CGSize(width: (size.width * Double(scale.rawValue)).rounded(), height: (size.height * Double(scale.rawValue)).rounded())
    }
}
