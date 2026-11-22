import CoreGraphics
import CryptoKit
import Foundation

// Pure rules behind the artifact canvas viewer: Illustrator stub detection, zoom, the pasteboard's artboard layout,
// document-size math for the scroll view, and the render cache key. The views (ArtifactViewer.swift,
// ArtifactCanvasView.swift) only draw what these decide.

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

/// When a stub `.ai` renders without being asked: only if Illustrator is already running (a closed one would launch).
public enum IllustratorAuto {
    public static func shouldRender(appRunning: Bool, idle: Bool) -> Bool { appRunning && idle }
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

    /// The ExtendScript run inside Illustrator: open the file, save each artboard as its own PDF into `<out>/art.pdf`,
    /// write the artboard names to `<out>/names.json`, close without saving. Paths are JSON-escaped string literals.
    /// Returns "ok:<n>" on success or "error: <message> line <line>" on failure.
    public static func script(file: String, out: String) -> String {
        func lit(_ s: String) -> String {
            let enc = JSONEncoder()
            enc.outputFormatting = .withoutEscapingSlashes
            guard let d = try? enc.encode(s), let t = String(data: d, encoding: .utf8) else { return "\"\"" }
            return t
        }
        return """
            var res;
            var previous = app.userInteractionLevel;
            try {
              app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
              var src = new File(\(lit(file)));
              var out = new Folder(\(lit(out)));
              out.create();
              var doc = app.open(src);
              try {
                var names = [];
                var n = doc.artboards.length;
                for (var i = 0; i < n; i++) {
                  names.push(doc.artboards[i].name);
                }
                var o = new PDFSaveOptions();
                o.preserveEditability = false;
                o.viewAfterSaving = false;
                o.saveMultipleArtboards = true;
                o.artboardRange = n > 1 ? ("1-" + n) : "1";
                doc.saveAs(new File(out.fsName + "/art.pdf"), o);

                var meta = new File(out.fsName + "/names.json");
                meta.encoding = "UTF-8";
                meta.open("w");
                var json = "[";
                for (var k = 0; k < names.length; k++) {
                  json += (k ? "," : "") + "\\\"" + String(names[k]).replace(/([\"\\\\])/g, "\\\\$1") + "\\\"";
                }
                meta.write(json + "]");
                meta.close();
                res = "ok:" + n;
              } finally {
                doc.close(SaveOptions.DONOTSAVECHANGES);
              }
            } catch (e) {
              res = "error: " + (e.message || String(e)) + (e.line ? (" line " + e.line) : "");
            } finally {
              app.userInteractionLevel = previous;
            }
            res;
            """
    }

    /// Result of parsing the ExtendScript output string.
    public enum ScriptResult: Equatable, Sendable {
        case ok(artboards: Int)
        case error(String)
    }

    /// Parses the result string from ExtendScript ("ok:<n>" or "error: <message>").
    public static func parseResult(_ text: String) -> ScriptResult? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        if trimmed.hasPrefix("ok:") {
            let countStr = trimmed.dropFirst(3)
            return .ok(artboards: Int(countStr) ?? 0)
        }
        if trimmed == "ok" {
            return .ok(artboards: 1)
        }
        if trimmed.hasPrefix("error:") {
            let msg = trimmed.dropFirst(6).trimmingCharacters(in: .whitespaces)
            return .error(msg.isEmpty ? "Unknown Illustrator error." : String(msg))
        }
        return .error(trimmed)
    }

    /// Names written by the script (`names.json`); nil when the file is not a JSON array of strings.
    public static func names(from data: Data) -> [String]? { try? JSONDecoder().decode([String].self, from: data) }
}

/// Zoom for the canvas: 2% to 6400%, stepped by the usual stops.
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

/// Document-size maths for the NSScrollView-backed canvas: the world bounds of all artboards plus pasteboard padding
/// (one viewport on every side so the user can pan freely), and the fit magnification.
public enum CanvasDocumentSize {
    /// The document view's size in world points: artboard bounds inflated by one viewport on every side.
    /// `viewportSize` is the clip view's visible size in points (at magnification 1). Returns at least 1×1.
    public static func documentSize(artboardBounds: CGRect, viewportSize: CGSize) -> CGSize {
        let padX = max(viewportSize.width, 1)
        let padY = max(viewportSize.height, 1)
        let w = artboardBounds.width + 2 * padX
        let h = artboardBounds.height + 2 * padY
        return CGSize(width: max(w, 1), height: max(h, 1))
    }

    /// The origin of the document view in world coordinates (the top-left corner of the document rect).
    public static func documentOrigin(artboardBounds: CGRect, viewportSize: CGSize) -> CGPoint {
        let padX = max(viewportSize.width, 1)
        let padY = max(viewportSize.height, 1)
        return CGPoint(x: artboardBounds.minX - padX, y: artboardBounds.minY - padY)
    }

    /// The magnification that fits `rect` (world) inside `viewportSize` with `padding` pts around it, capped at `maxMag`.
    public static func fitMagnification(
        rect: CGRect, viewportSize: CGSize, padding: Double = 48, maxMag: Double = 1
    ) -> Double {
        guard rect.width > 0, rect.height > 0, viewportSize.width > 0, viewportSize.height > 0 else { return 1 }
        let zx = max(viewportSize.width - 2 * padding, 1) / rect.width
        let zy = max(viewportSize.height - 2 * padding, 1) / rect.height
        return CanvasZoom.clamp(min(zx, zy, maxMag))
    }

    /// The scroll position (document-view origin in the clip view) that centres `worldRect` at `magnification` in a
    /// clip view of `viewportSize`, given the document view's `docOrigin`.
    public static func centredScrollPoint(
        worldRect: CGRect, magnification: Double, viewportSize: CGSize, docOrigin: CGPoint
    ) -> CGPoint {
        let cx = (worldRect.midX - docOrigin.x) * magnification - viewportSize.width / 2
        let cy = (worldRect.midY - docOrigin.y) * magnification - viewportSize.height / 2
        return CGPoint(x: max(cx, 0), y: max(cy, 0))
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
