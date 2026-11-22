import CoreGraphics
import CryptoKit
import Foundation

// Pure rules behind the artifact canvas viewer: Illustrator stub detection, zoom, the pasteboard's artboard layout and
// the render cache key. The views (ArtifactViewer.swift, ArtifactCanvasView.swift) only draw what these decide.

/// An Illustrator file saved without PDF compatibility still carries a one-page PDF, whose only content is Adobe's
/// placeholder sentence. That page is not the artwork and must never be shown as it.
public enum IllustratorStub {
    /// The phrase in Illustrator's placeholder page ("... saved without PDF Content. To Place or open this file ...").
    public static let marker = "saved without pdf content"

    /// Whether the text of an `.ai` file's embedded PDF pages is the placeholder. Whitespace and case do not matter.
    public static func isStub(pageText: String?) -> Bool {
        guard let text = pageText else { return false }
        let flat = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ").lowercased()
        return flat.contains(marker)
    }

    /// The one-line reason shown when the artwork cannot be drawn.
    public static let explanation = "This file was saved without PDF content, so it has no preview inside."
}

/// Where Illustrator's renders of a stub `.ai` are cached: one folder per file and modification time.
public enum ArtifactRenderCache {
    /// 16 hex characters from the path and mtime (a changed file gets a new folder; the old one is just stale).
    public static func key(path: String, modified: Date) -> String {
        let seed = "\(path)|\(Int64((modified.timeIntervalSince1970 * 1000).rounded()))"
        return SHA256.hash(data: Data(seed.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// `<support>/artifact-render/<key>`.
    public static func folder(support: URL, path: String, modified: Date) -> URL {
        support.appending(path: "artifact-render").appending(path: key(path: path, modified: modified))
    }

    /// The ExtendScript run inside Illustrator: open the file, save each artboard as its own PDF into `<out>/<i>/art.pdf`,
    /// write the artboard names to `<out>/names.json`, close without saving. Paths are JSON-escaped string literals.
    public static func script(file: String, out: String) -> String {
        func lit(_ s: String) -> String {
            let enc = JSONEncoder()
            enc.outputFormatting = .withoutEscapingSlashes
            guard let d = try? enc.encode(s), let t = String(data: d, encoding: .utf8) else { return "\"\"" }
            return t
        }
        return """
            var src = new File(\(lit(file)));
            var out = new Folder(\(lit(out)));
            out.create();
            var previous = app.userInteractionLevel;
            app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
            var doc = app.open(src);
            var names = [];
            try {
              var n = doc.artboards.length;
              for (var i = 0; i < n; i++) {
                doc.artboards.setActiveArtboardIndex(i);
                names.push(doc.artboards[i].name);
                var dir = new Folder(out.fsName + "/" + i);
                dir.create();
                var o = new PDFSaveOptions();
                o.saveMultipleArtboards = true;
                o.artboardRange = String(i + 1);
                o.preserveEditability = false;
                o.viewAfterSaving = false;
                doc.saveAs(new File(dir.fsName + "/art.pdf"), o);
              }
              var meta = new File(out.fsName + "/names.json");
              meta.open("w");
              var json = "[";
              for (var k = 0; k < names.length; k++) { json += (k ? "," : "") + "\\"" + String(names[k]).replace(/(["\\\\])/g, "\\\\$1") + "\\""; }
              meta.write(json + "]");
              meta.close();
            } finally {
              doc.close(SaveOptions.DONOTSAVECHANGES);
              app.userInteractionLevel = previous;
            }
            "ok";
            """
    }

    /// Names written by the script (`names.json`); nil when the file is not a JSON array of strings.
    public static func names(from data: Data) -> [String]? { try? JSONDecoder().decode([String].self, from: data) }
}

/// Zoom for the canvas: 2% to 6400%, stepped by the usual stops, and the pointer-anchored viewport maths.
public enum CanvasZoom {
    public static let range: ClosedRange<Double> = 0.02...64
    public static let stops: [Double] = [0.02, 0.03, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64]

    public static func clamp(_ z: Double) -> Double { min(max(z, range.lowerBound), range.upperBound) }

    /// The next stop above (or below) `z`; at either end it stays.
    public static func step(_ z: Double, in zoomIn: Bool) -> Double {
        let eps = 1e-6
        if zoomIn { return stops.first { $0 > z * (1 + eps) } ?? range.upperBound }
        return stops.last { $0 < z / (1 + eps) } ?? range.lowerBound
    }

    /// A trackpad pinch's `magnification` (about -1...1 per event) as a zoom factor.
    public static func factor(magnification: Double) -> Double { max(0.05, 1 + magnification) }

    /// "83%" (whole percent; below 10% one decimal so 2% and 6% read true).
    public static func percentText(_ z: Double) -> String {
        let p = z * 100
        return p < 10 ? String(format: "%.1f%%", p).replacingOccurrences(of: ".0%", with: "%") : "\(Int(p.rounded()))%"
    }
}

/// Which part of the pasteboard the window shows: `origin` is the world point at the window's top-left, `zoom` the
/// points per world unit. World and window are both y-down.
public struct CanvasViewport: Equatable, Sendable {
    public var origin: CGPoint
    public var zoom: Double

    public init(origin: CGPoint = .zero, zoom: Double = 1) {
        self.origin = origin
        self.zoom = CanvasZoom.clamp(zoom)
    }

    public func world(fromView p: CGPoint) -> CGPoint { CGPoint(x: origin.x + p.x / zoom, y: origin.y + p.y / zoom) }
    public func view(fromWorld p: CGPoint) -> CGPoint { CGPoint(x: (p.x - origin.x) * zoom, y: (p.y - origin.y) * zoom) }

    /// Zoom to `newZoom` (clamped) keeping the world point under `anchor` (window coordinates) where it is.
    public func zoomed(to newZoom: Double, anchor: CGPoint) -> CanvasViewport {
        let z = CanvasZoom.clamp(newZoom)
        let w = world(fromView: anchor)
        return CanvasViewport(origin: CGPoint(x: w.x - anchor.x / z, y: w.y - anchor.y / z), zoom: z)
    }

    /// Content follows the fingers: move by `delta` window points.
    public func panned(byView delta: CGSize) -> CanvasViewport {
        CanvasViewport(origin: CGPoint(x: origin.x - delta.width / zoom, y: origin.y - delta.height / zoom), zoom: zoom)
    }

    /// The viewport showing `rect` (world) centred in a window of `size`, with `padding` window points around it. A
    /// small piece is never enlarged past `maxZoom` (so one tiny artboard fits at 100% rather than 6400%).
    public static func fitting(_ rect: CGRect, in size: CGSize, padding: Double = 48, maxZoom: Double = 1) -> CanvasViewport {
        guard rect.width > 0, rect.height > 0, size.width > 0, size.height > 0 else { return CanvasViewport() }
        let zx = max(size.width - 2 * padding, 1) / rect.width
        let zy = max(size.height - 2 * padding, 1) / rect.height
        let z = CanvasZoom.clamp(min(zx, zy, maxZoom))
        let origin = CGPoint(x: rect.midX - size.width / (2 * z), y: rect.midY - size.height / (2 * z))
        return CanvasViewport(origin: origin, zoom: z)
    }

    /// The affine map from a layer already drawn at `committed` to how `self` should look: scale then translate, in
    /// window (y-down) points. Used to preview a gesture before the crisp redraw.
    public func preview(from committed: CanvasViewport) -> (scale: Double, translate: CGSize) {
        let s = zoom / committed.zoom
        return (s, CGSize(width: (committed.origin.x - origin.x) * zoom, height: (committed.origin.y - origin.y) * zoom))
    }
}

/// Artboards side by side on the pasteboard, as Illustrator lays them out.
public enum ArtboardLayout {
    public static let gap: Double = 80

    /// Frames for boards of `sizes`, left to right in one row, top-aligned, `gap` apart, starting at the origin.
    public static func place(_ sizes: [CGSize], gap: Double = ArtboardLayout.gap) -> [CGRect] {
        var x = 0.0
        return sizes.map { s in
            defer { x += s.width + gap }
            return CGRect(x: x, y: 0, width: s.width, height: s.height)
        }
    }

    /// The box around all frames; zero when there are none.
    public static func bounds(_ frames: [CGRect]) -> CGRect {
        let all = frames.reduce(CGRect.null) { $0.union($1) }
        return all.isNull ? .zero : all
    }

    /// The board nearest a world point (the one containing it, else the closest by centre).
    public static func nearest(_ frames: [CGRect], to p: CGPoint) -> Int? {
        if let hit = frames.firstIndex(where: { $0.contains(p) }) { return hit }
        return frames.indices.min { a, b in
            hypot(frames[a].midX - p.x, frames[a].midY - p.y) < hypot(frames[b].midX - p.x, frames[b].midY - p.y)
        }
    }

    /// "Artboard 2" when the file gives no name; never an empty label.
    public static func label(name: String?, index: Int) -> String {
        let t = name?.trimmingCharacters(in: .whitespaces) ?? ""
        return t.isEmpty ? "Artboard \(index + 1)" : t
    }
}

/// The page or artboard switcher (shown only when there is more than one) and its "2/3" text.
public enum ArtifactSwitcher {
    public static func shown(count: Int) -> Bool { count > 1 }
    public static func text(index: Int, count: Int) -> String { "\(index + 1)/\(count)" }
    public static func stepped(_ index: Int, by delta: Int, count: Int) -> Int { min(max(index + delta, 0), max(count - 1, 0)) }
}
