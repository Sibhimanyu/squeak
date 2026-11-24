import CoreGraphics
import Foundation

// Canvas hand editing (phase 2): the pure rules behind the live artboard, the Design inspector and the artboard list.
// The script that edits the page is `Resources/canvas-edit.js`; the host writes the files (`src/native/canvases.ts`).
// Nothing here touches WebKit or the disk except `CanvasBundle.unpack`, which writes a view-only copy of a remote canvas.

// MARK: Undo and redo

/// One artboard's history: the whole HTML after each committed change, a cursor on the shown one. Capped by steps and by
/// size, oldest dropped first; identical consecutive states are one.
public struct EditHistory: Equatable, Sendable {
    public static let maxSteps = 100
    public static let maxBytes = 48_000_000
    public private(set) var states: [String]
    public private(set) var cursor: Int

    public init(initial: String) { states = [initial]; cursor = 0 }

    public var current: String { states[cursor] }
    public var canUndo: Bool { cursor > 0 }
    public var canRedo: Bool { cursor < states.count - 1 }

    /// A change was committed: it becomes the shown state and the redo steps are gone.
    public mutating func record(_ state: String) {
        guard state != current else { return }
        states.removeSubrange((cursor + 1)...)
        states.append(state)
        cursor = states.count - 1
        trim()
    }

    /// The state to show after stepping back; nil at the start.
    public mutating func undo() -> String? {
        guard canUndo else { return nil }
        cursor -= 1
        return current
    }

    public mutating func redo() -> String? {
        guard canRedo else { return nil }
        cursor += 1
        return current
    }

    /// Starts over from `state` (the artboard was reloaded from disk).
    public mutating func reset(to state: String) { states = [state]; cursor = 0 }

    private mutating func trim() {
        var bytes = states.reduce(0) { $0 + $1.utf8.count }
        while states.count > 1, states.count > Self.maxSteps || bytes > Self.maxBytes {
            bytes -= states[0].utf8.count
            states.removeFirst()
            cursor -= 1
        }
    }
}

// MARK: A duck changing the artboard while it is being edited

public enum EditMerge {
    public enum Decision: Equatable, Sendable {
        /// The person has changed nothing: show the duck's version.
        case adopt
        /// Each touched different elements: show the merge (the script made it).
        case merge
        /// Both touched these elements: keep the person's, say a duck changed it, offer Reload.
        case keepMine([String])
    }

    public static func decide(mineChanged: Bool, conflicts: [String]) -> Decision {
        if !mineChanged { return .adopt }
        return conflicts.isEmpty ? .merge : .keepMine(conflicts)
    }

    /// Whether a file's stamp is someone else's write: every stamp the host gave back for our own saves, and the one the
    /// artboard was opened at, are ours.
    public static func isExternal(stamp: Int64, known: Set<Int64>) -> Bool { !known.contains(stamp) }

    public static let note = "A duck changed this artboard"
}

// MARK: Artboard list

public enum ArtboardPresets {
    public struct Preset: Equatable, Sendable, Identifiable {
        public var name: String
        public var width: Double
        public var height: Double
        public var id: String { "\(name) \(Int(width))x\(Int(height))" }
        public var detail: String { "\(Int(width)) \u{00D7} \(Int(height))" }
    }

    private static let slide = Preset(name: "Slide 16:9", width: 1920, height: 1080)
    private static let slide43 = Preset(name: "Slide 4:3", width: 1440, height: 1080)
    private static let square = Preset(name: "Square", width: 1080, height: 1080)
    private static let portrait = Preset(name: "Portrait 4:5", width: 1080, height: 1350)
    private static let story = Preset(name: "Story 9:16", width: 1080, height: 1920)
    private static let landscape = Preset(name: "Landscape", width: 1200, height: 630)
    private static let a4 = Preset(name: "A4", width: 1240, height: 1754)
    private static let letter = Preset(name: "Letter", width: 1275, height: 1650)
    private static let logo = Preset(name: "Logo", width: 1024, height: 1024)
    private static let wordmark = Preset(name: "Wordmark", width: 1600, height: 900)

    /// The sizes a "+" offers, the canvas kind's own first.
    public static func presets(for kind: CanvasKind) -> [Preset] {
        switch kind {
        case .deck: [slide, slide43, square, portrait]
        case .poster: [Preset(name: "Poster", width: 1080, height: 1350), a4, letter, story]
        case .logo: [logo, wordmark, square]
        case .social: [square, portrait, story, landscape]
        case .blank: [square, slide, portrait, a4]
        }
    }
}

public enum CanvasOrder {
    /// The ids after dragging the row at `from` to sit before the row that was at `to` (SwiftUI's `onMove` meaning).
    public static func moved(_ ids: [String], from: Int, to: Int) -> [String] {
        guard ids.indices.contains(from), to >= 0, to <= ids.count, to != from, to != from + 1 else { return ids }
        var out = ids
        let item = out.remove(at: from)
        out.insert(item, at: to > from ? to - 1 : to)
        return out
    }

    /// The row to select after a delete: the one now in the deleted row's place, else the last.
    public static func selectionAfterDelete(index: Int, remaining: Int) -> Int { max(0, min(index, remaining - 1)) }
}

/// Words the artboard list's context menu uses; kept here so the menu and the tests agree.
public enum ArtboardMenu {
    public static let rename = "Rename"
    public static let duplicate = "Duplicate"
    public static let delete = "Delete"
    /// The last artboard cannot be deleted: a canvas always has one.
    public static func canDelete(count: Int) -> Bool { count > 1 }
}

/// What the host's `POST /native/canvases/manage` is asked.
public enum CanvasOp: Sendable, Equatable {
    case add(name: String?, width: Double?, height: Double?)
    case rename(id: String, name: String)
    case duplicate(id: String)
    case delete(id: String)
    case reorder([String])
    case resize(id: String, width: Double, height: Double)

    var body: NativeJSON {
        switch self {
        case .add(let name, let w, let h):
            var o: [String: NativeJSON] = ["op": .string("add")]
            if let name { o["name"] = .string(name) }
            if let w { o["width"] = .number(w) }
            if let h { o["height"] = .number(h) }
            return .object(o)
        case .rename(let id, let name): return .object(["op": .string("rename"), "id": .string(id), "name": .string(name)])
        case .duplicate(let id): return .object(["op": .string("duplicate"), "id": .string(id)])
        case .delete(let id): return .object(["op": .string("delete"), "id": .string(id)])
        case .reorder(let ids): return .object(["op": .string("reorder"), "order": .array(ids.map { .string($0) })])
        case .resize(let id, let w, let h): return .object(["op": .string("resize"), "id": .string(id), "width": .number(w), "height": .number(h)])
        }
    }
}

extension NativeHostClient {
    /// `PUT /native/canvases/artboard`: a hand edit's whole artboard HTML. Returns the file's new modified stamp (ms).
    public func saveArtboard(path: String, id: String, html: String) async throws -> Int64 {
        let data = try await call("PUT", "/native/canvases/artboard?path=\(Self.id(path))&id=\(Self.id(id))", body: .object(["html": .string(html)]), timeout: 20)
        struct Saved: Decodable { var modifiedAt: Int64? }
        return (try? JSONDecoder().decode(Saved.self, from: data))?.modifiedAt ?? 0
    }

    /// `POST /native/canvases/manage`: add, rename, duplicate, delete, reorder or resize artboards; the canvas as it is now.
    @discardableResult
    public func manageCanvas(path: String, _ op: CanvasOp) async throws -> CanvasDetail {
        let data = try await call("POST", "/native/canvases/manage?path=\(Self.id(path))", body: op.body, timeout: 15)
        return try JSONDecoder.native(CanvasDetail.self, data)
    }
}

// MARK: Pictures

public enum CanvasAsset {
    public static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "tiff", "tif", "bmp", "avif"]

    public static func isImage(_ fileName: String) -> Bool { imageExtensions.contains((fileName as NSString).pathExtension.lowercased()) }

    /// The name a picture gets in `assets/`: letters, digits, dashes and underscores, the extension lowercased, never one
    /// that is taken (`-2`, `-3`, ...).
    public static func assetName(for fileName: String, existing: Set<String>) -> String {
        let file = (fileName as NSString).lastPathComponent
        let ext = (file as NSString).pathExtension.lowercased()
        let stem = CanvasExport.safe((file as NSString).deletingPathExtension, fallback: "image")
        let suffix = ext.isEmpty ? "" : ".\(ext)"
        var name = stem + suffix
        var n = 2
        while existing.contains(name) { name = "\(stem)-\(n)\(suffix)"; n += 1 }
        return name
    }

    /// The `src` an artboard uses for a file in `assets/`: artboards sit in `artboards/`, one folder in.
    public static func source(for assetName: String) -> String { "../assets/\(assetName)" }
}

// MARK: The Design inspector

/// One selected element as the editing script describes it.
public struct DesignItem: Decodable, Equatable, Sendable {
    public var id: String
    public var tag: String
    public var text: Bool
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double
    public var rotation: Double
    public var opacity: Double
    public var fontFamily: String
    public var fontSize: Double
    public var fontWeight: String
    public var color: String
    public var textAlign: String
    public var lineHeight: Double
    public var background: String
    public var radius: Double
    public var borderWidth: Double
    public var borderColor: String
    public var borderStyle: String

    public init(id: String = "sq1", tag: String = "div", text: Bool = false, x: Double = 0, y: Double = 0, w: Double = 100, h: Double = 100,
                rotation: Double = 0, opacity: Double = 1, fontFamily: String = "", fontSize: Double = 16, fontWeight: String = "400",
                color: String = "#111111", textAlign: String = "left", lineHeight: Double = 0, background: String = "", radius: Double = 0,
                borderWidth: Double = 0, borderColor: String = "", borderStyle: String = "none") {
        self.id = id; self.tag = tag; self.text = text; self.x = x; self.y = y; self.w = w; self.h = h; self.rotation = rotation
        self.opacity = opacity; self.fontFamily = fontFamily; self.fontSize = fontSize; self.fontWeight = fontWeight; self.color = color
        self.textAlign = textAlign; self.lineHeight = lineHeight; self.background = background; self.radius = radius
        self.borderWidth = borderWidth; self.borderColor = borderColor; self.borderStyle = borderStyle
    }

    /// An element that is a picture: no text style, no fill.
    public var isImage: Bool { tag == "img" }
    public var label: String { text ? "Text" : isImage ? "Image" : tag == "svg" ? "Graphic" : "Shape" }
}

public enum DesignSelection {
    /// The items in a `selection` message the script posted (a Foundation dictionary); empty for anything else.
    public static func items(in body: Any) -> [DesignItem] {
        guard let dict = body as? [String: Any], dict["t"] as? String == "selection", let raw = dict["items"],
              JSONSerialization.isValidJSONObject(raw), let data = try? JSONSerialization.data(withJSONObject: raw),
              let list = try? JSONDecoder().decode([Failable<DesignItem>].self, from: data)
        else { return [] }
        return list.compactMap(\.value)
    }
}

/// What the inspector changes; the raw value is the script's name for it.
public enum DesignProp: String, Sendable, CaseIterable {
    case x, y, w, h, rotation, opacity
    case fontFamily, fontSize, fontWeight, color, textAlign, lineHeight
    case background, radius, borderWidth, borderColor, borderStyle
}

public enum DesignValue: Sendable, Equatable {
    case number(Double)
    case string(String)

    /// For `callAsyncJavaScript` arguments.
    public var jsonObject: Any {
        switch self {
        case .number(let n): n
        case .string(let s): s
        }
    }
}

public enum DesignInput {
    /// A number typed into a field: "12", "12.5", "12 px", "1,5" (a comma as the point); nil for anything else.
    public static func number(_ text: String) -> Double? {
        var t = text.trimmingCharacters(in: .whitespaces).lowercased()
        for unit in ["px", "pt", "deg", "\u{00B0}", "%"] where t.hasSuffix(unit) { t.removeLast(unit.count) }
        t = t.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        guard !t.isEmpty, let v = Double(t), v.isFinite else { return nil }
        return v
    }

    /// "#abc", "aabbcc" or "#AABBCC" as "#aabbcc"; nil when it is not a colour.
    public static func hex(_ text: String) -> String? {
        var t = text.trimmingCharacters(in: .whitespaces).lowercased()
        if t.hasPrefix("#") { t.removeFirst() }
        guard t.allSatisfy({ $0.isHexDigit }) else { return nil }
        if t.count == 3 { t = t.map { "\($0)\($0)" }.joined() }
        return t.count == 6 ? "#" + t : nil
    }

    /// A number as a field shows it: no trailing ".0", one decimal at most.
    public static func display(_ v: Double) -> String {
        let r = (v * 10).rounded() / 10
        return r == r.rounded() ? String(Int(r)) : String(r)
    }

    /// Opacity is typed as a percentage and sent as 0...1.
    public static func opacity(percent: Double) -> Double { min(1, max(0, percent / 100)) }
}

public enum DesignFonts {
    public struct Font: Equatable, Sendable, Identifiable {
        public var name: String
        /// What the script writes as `font-family`; "System" is mapped by the script itself.
        public var css: String
        public var id: String { name }
    }

    /// The system face and the web-safe ones every Mac and most readers have.
    public static let all: [Font] = [
        Font(name: "System", css: "System"),
        Font(name: "Helvetica Neue", css: "\"Helvetica Neue\", Helvetica, Arial, sans-serif"),
        Font(name: "Arial", css: "Arial, Helvetica, sans-serif"),
        Font(name: "Verdana", css: "Verdana, Geneva, sans-serif"),
        Font(name: "Trebuchet MS", css: "\"Trebuchet MS\", Helvetica, sans-serif"),
        Font(name: "Tahoma", css: "Tahoma, Geneva, sans-serif"),
        Font(name: "Georgia", css: "Georgia, \"Times New Roman\", serif"),
        Font(name: "Times New Roman", css: "\"Times New Roman\", Times, serif"),
        Font(name: "Palatino", css: "Palatino, \"Palatino Linotype\", serif"),
        Font(name: "Garamond", css: "Garamond, \"Times New Roman\", serif"),
        Font(name: "Courier New", css: "\"Courier New\", Courier, monospace"),
        Font(name: "Menlo", css: "Menlo, Monaco, monospace"),
    ]

    /// The listed font whose first family is the computed `font-family`'s first family (system stacks read as System).
    public static func match(_ cssFamily: String) -> Font? {
        let first = cssFamily.split(separator: ",").first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")).lowercased() } ?? ""
        if first.isEmpty || first == "-apple-system" || first == "system-ui" || first == "blinkmacsystemfont" { return all[0] }
        return all.first { $0.name.lowercased() == first }
    }

    /// The first family as written, for a face that is not in the list.
    public static func firstFamily(_ cssFamily: String) -> String {
        cssFamily.split(separator: ",").first.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'")) } ?? ""
    }

    public static let weights: [(value: String, name: String)] = [
        ("300", "Light"), ("400", "Regular"), ("500", "Medium"), ("600", "Semibold"), ("700", "Bold"), ("800", "Heavy"),
    ]

    /// The listed weight nearest a computed one ("bold" and "normal" are read as 700 and 400).
    public static func weight(_ css: String) -> String {
        let n = css == "bold" ? 700 : css == "normal" ? 400 : Int(css) ?? 400
        return weights.min { abs(Int($0.value)! - n) < abs(Int($1.value)! - n) }!.value
    }

    public static let alignments = ["left", "center", "right", "justify"]
    public static let borderStyles = ["none", "solid", "dashed", "dotted"]
}

// MARK: Remote canvases (view only)

public enum CanvasBundleError: Error, Equatable { case notABundle, unsafe, tooLarge }

/// A canvas the owner's Mac sent as one file (`packCanvasBundle` in `src/native/canvases.ts`), unpacked into a folder this
/// Mac can draw. Every name is checked before anything is written; nothing leaves the destination folder.
public enum CanvasBundle {
    public static let format = "squeak-canvas-bundle"
    public static let maxBytes = 25 * 1024 * 1024
    private static let idPattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,47}$")

    public static func isSafeID(_ id: String) -> Bool {
        idPattern.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)) != nil
    }

    /// One path component of an asset: plain, not hidden, no separators.
    public static func isPlainName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.hasPrefix(".") && !name.contains("/") && !name.contains("\\") && !name.contains("\0")
    }

    /// An asset's path under `assets/`: one to four plain components.
    public static func isSafeAssetPath(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        return (1...4).contains(parts.count) && parts.allSatisfy(isPlainName)
    }

    /// Writes the bundle to `folder` (replacing what is there) and returns what the viewer reads.
    public static func unpack(_ data: Data, into folder: URL) throws -> CanvasDetail {
        guard data.count <= maxBytes + maxBytes / 2 else { throw CanvasBundleError.tooLarge }
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], root["format"] as? String == format,
              let canvas = root["canvas"] as? [String: Any], let title = canvas["title"] as? String,
              let boards = canvas["artboards"] as? [[String: Any]], let html = root["artboards"] as? [String: String]
        else { throw CanvasBundleError.notABundle }
        let assets = (root["assets"] as? [String: String]) ?? [:]
        var infos: [CanvasArtboardInfo] = []
        var seen = Set<String>()
        var total = 0
        for b in boards {
            guard let id = b["id"] as? String, isSafeID(id), seen.insert(id).inserted, let w = (b["width"] as? NSNumber)?.doubleValue,
                  let h = (b["height"] as? NSNumber)?.doubleValue, (16...8000).contains(w), (16...8000).contains(h)
            else { throw CanvasBundleError.unsafe }
            total += html[id]?.utf8.count ?? 0
            infos.append(CanvasArtboardInfo(id: id, name: (b["name"] as? String) ?? id, width: w.rounded(), height: h.rounded(),
                                            background: b["background"] as? String))
        }
        var pictures: [(path: String, bytes: Data)] = []
        for (path, b64) in assets {
            guard isSafeAssetPath(path), let bytes = Data(base64Encoded: b64) else { throw CanvasBundleError.unsafe }
            total += bytes.count
            pictures.append((path, bytes))
        }
        guard total <= maxBytes else { throw CanvasBundleError.tooLarge }

        let fm = FileManager.default
        let base = folder.standardizedFileURL
        try? fm.removeItem(at: base)
        try fm.createDirectory(at: base.appending(path: "artboards"), withIntermediateDirectories: true)
        try fm.createDirectory(at: base.appending(path: "assets"), withIntermediateDirectories: true)
        func inside(_ url: URL) throws -> URL {
            let u = url.standardizedFileURL
            guard u.path.hasPrefix(base.path + "/") else { throw CanvasBundleError.unsafe }
            return u
        }
        let stamp = Int64(Date().timeIntervalSince1970 * 1000)
        for i in infos.indices {
            let file = try inside(base.appending(path: "artboards/\(infos[i].id).html"))
            try Data((html[infos[i].id] ?? "").utf8).write(to: file, options: .atomic)
            infos[i].file = file.path
            infos[i].modifiedAt = stamp
        }
        for p in pictures {
            let file = try inside(base.appending(path: "assets/\(p.path)"))
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try p.bytes.write(to: file, options: .atomic)
        }
        let doc: [String: Any] = ["version": 1, "title": title, "kind": canvas["kind"] as? String ?? "blank", "artboards": boards]
        try JSONSerialization.data(withJSONObject: doc).write(to: base.appending(path: "canvas.json"), options: .atomic)
        return CanvasDetail(path: base.path, title: title, kind: CanvasKind(wire: canvas["kind"] as? String), artboards: infos, assetsModifiedAt: stamp)
    }

    /// Where a bundle file's folder goes: `<temp>/SqueakRemoteCanvas/<hash of the bundle path>/<name>.canvas`.
    public static func folder(forBundle bundlePath: String, temp: URL = FileManager.default.temporaryDirectory) -> URL {
        var h: UInt64 = 1469598103934665603
        for b in bundlePath.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        let name = CanvasExport.safe(((bundlePath as NSString).lastPathComponent as NSString).deletingPathExtension, fallback: "canvas")
        return temp.appending(path: "SqueakRemoteCanvas/\(String(h, radix: 16))/\(name).canvas")
    }
}
