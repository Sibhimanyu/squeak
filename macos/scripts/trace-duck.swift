#!/usr/bin/env swift
// Dev tool: vectorises the duck master artwork into Swift source.
//
//   swift macos/scripts/trace-duck.swift [master.png] [out.swift]
//
// Defaults: .context/v3/mock/duck-glyph.png -> macos/Sources/SqueakMac/DuckGlyphPath.swift
// (paths are relative to the repo root; run it from there).
//
// Pipeline: Vision VNDetectContoursRequest (dark-on-light, contrast boosted) finds the outer
// silhouette and its holes (the eye, the wing line). Each contour is lightly smoothed,
// simplified (Douglas-Peucker) and re-fitted with Catmull-Rom splines turned into cubic Beziers,
// keeping genuine corners sharp. The eye is replaced by a true circle. Everything is normalised
// to the silhouette's bounding box (0...1, y down) with the aspect ratio recorded.
import CoreGraphics
import Foundation
import ImageIO
import Vision

let args = CommandLine.arguments
let inPath = args.count > 1 ? args[1] : ".context/v3/mock/duck-glyph.png"
let outPath = args.count > 2 ? args[2] : "macos/Sources/SqueakMac/DuckGlyphPath.swift"

struct P { var x: Double; var y: Double }

func fail(_ m: String) -> Never { FileHandle.standardError.write(Data((m + "\n").utf8)); exit(1) }

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: inPath) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("cannot read \(inPath)") }

let request = VNDetectContoursRequest()
request.contrastAdjustment = 3.0
request.detectsDarkOnLight = true
request.maximumImageDimension = max(image.width, image.height)
try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
guard let obs = request.results?.first else { fail("no contours") }

// Biggest top-level contour is the duck; its children are holes.
func area(_ pts: [P]) -> Double {
    var a = 0.0
    for i in 0..<pts.count { let j = (i + 1) % pts.count; a += pts[i].x * pts[j].y - pts[j].x * pts[i].y }
    return abs(a) / 2
}
func points(_ c: VNContour) -> [P] {
    // Vision: normalised, origin bottom-left. Flip to y down, scale by pixels so aspect is real.
    let w = Double(image.width), h = Double(image.height)
    return c.normalizedPoints.map { P(x: Double($0.x) * w, y: (1 - Double($0.y)) * h) }
}
let top = obs.topLevelContours.max { area(points($0)) < area(points($1)) }!
let outerRaw = points(top)
let holes = top.childContours.map(points).filter { area($0) > 50 }.sorted { area($0) > area($1) }
guard holes.count >= 1 else { fail("no eye found") }

// Eye = the roughly circular hole; wing = the elongated one.
func bbox(_ pts: [P]) -> (minX: Double, minY: Double, maxX: Double, maxY: Double) {
    (pts.map(\.x).min()!, pts.map(\.y).min()!, pts.map(\.x).max()!, pts.map(\.y).max()!)
}
func elongation(_ pts: [P]) -> Double { let b = bbox(pts); let w = b.maxX - b.minX, h = b.maxY - b.minY; return max(w, h) / min(w, h) }
let eyeRaw = holes.min { elongation($0) < elongation($1) }!
let wingRaw = holes.filter { $0.count != eyeRaw.count || $0[0].x != eyeRaw[0].x }.max { elongation($0) < elongation($1) }

let ob = bbox(outerRaw)
let W = ob.maxX - ob.minX, H = ob.maxY - ob.minY
func norm(_ p: P) -> P { P(x: (p.x - ob.minX) / W, y: (p.y - ob.minY) / H) }

func smooth(_ pts: [P], passes: Int) -> [P] {
    var cur = pts
    for _ in 0..<passes {
        let n = cur.count
        cur = (0..<n).map { i in
            let a = cur[(i + n - 1) % n], b = cur[i], c = cur[(i + 1) % n]
            return P(x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4)
        }
    }
    return cur
}
func dist(_ p: P, _ a: P, _ b: P) -> Double {
    let dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy
    if l == 0 { return hypot(p.x - a.x, p.y - a.y) }
    let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l))
    return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}
func dp(_ pts: [P], _ eps: Double) -> [P] {
    guard pts.count > 2 else { return pts }
    var idx = 0.0, at = 0
    for i in 1..<(pts.count - 1) { let d = dist(pts[i], pts[0], pts[pts.count - 1]); if d > idx { idx = d; at = i } }
    if idx <= eps { return [pts[0], pts[pts.count - 1]] }
    return Array(dp(Array(pts[0...at]), eps).dropLast()) + dp(Array(pts[at...]), eps)
}
/// Closed Douglas-Peucker: split at two far-apart anchors.
func simplifyClosed(_ pts: [P], eps: Double) -> [P] {
    let n = pts.count
    var far = 0, best = 0.0
    for i in 0..<n { let d = hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if d > best { best = d; far = i } }
    let a = dp(Array(pts[0...far]), eps)
    let b = dp(Array(pts[far...]) + [pts[0]], eps)
    return a + Array(b.dropFirst().dropLast())
}

/// Closed Catmull-Rom through `pts` -> cubic Beziers; corners (turn > cornerDeg) get zero tangents.
func bezier(_ pts: [P], cornerDeg: Double) -> [Double] {
    let n = pts.count
    func turn(_ i: Int) -> Double {
        let a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n]
        let a1 = atan2(b.y - a.y, b.x - a.x), a2 = atan2(c.y - b.y, c.x - b.x)
        var d = abs(a2 - a1) * 180 / .pi; if d > 180 { d = 360 - d }; return d
    }
    let corner = (0..<n).map { turn($0) > cornerDeg }
    func tan(_ i: Int) -> P {
        if corner[i] { return P(x: 0, y: 0) }
        let a = pts[(i + n - 1) % n], c = pts[(i + 1) % n]
        return P(x: (c.x - a.x) / 6, y: (c.y - a.y) / 6)
    }
    var out = [pts[0].x, pts[0].y]
    for i in 0..<n {
        let j = (i + 1) % n, p = pts[i], q = pts[j], t0 = tan(i), t1 = tan(j)
        out += [p.x + t0.x, p.y + t0.y, q.x - t1.x, q.y - t1.y, q.x, q.y]
    }
    return out
}
func trace(_ raw: [P], eps: Double, passes: Int, corner: Double) -> [Double] {
    let pts = simplifyClosed(smooth(raw.map(norm), passes: passes), eps: eps)
    return bezier(pts, cornerDeg: corner)
}

let body = trace(outerRaw, eps: 0.0022, passes: 3, corner: 55)
// Eye: circle from the hole's centroid and mean radius.
let eyeN = eyeRaw.map(norm)
let ecx = eyeN.map(\.x).reduce(0, +) / Double(eyeN.count), ecy = eyeN.map(\.y).reduce(0, +) / Double(eyeN.count)
let erx = eyeN.map { hypot(($0.x - ecx) * W, ($0.y - ecy) * H) }.reduce(0, +) / Double(eyeN.count) / W
let ery = erx * W / H
let wing = wingRaw.map { trace($0, eps: 0.0012, passes: 2, corner: 80) } ?? []

func fmt(_ a: [Double]) -> String {
    var lines: [String] = [], cur = "        "
    for (i, v) in a.enumerated() {
        let s = String(format: "%.4f", v) + (i == a.count - 1 ? "" : ", ")
        if cur.count + s.count > 112 { lines.append(cur.trimmingCharacters(in: .whitespaces == .whitespaces ? .whitespaces : .whitespaces)); cur = "        " }
        cur += s
    }
    lines.append(cur)
    return lines.map { "        " + $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "\n")
}

let code = """
// GENERATED by macos/scripts/trace-duck.swift. Do not edit by hand.
//
// Regenerate (from the repo root):
//   swift macos/scripts/trace-duck.swift .context/v3/mock/duck-glyph.png macos/Sources/SqueakMac/DuckGlyphPath.swift
//
// The duck master artwork, vectorised: Vision contours, Douglas-Peucker, Catmull-Rom -> cubic
// Beziers. Coordinates are normalised to the silhouette's bounding box (0...1, y down), so the
// glyph keeps its real proportions (`aspect` = width / height) wherever it is drawn.
import CoreGraphics

enum DuckGlyphPath {
    /// Width divided by height of the silhouette.
    static let aspect: CGFloat = \(String(format: "%.4f", W / H))

    /// The silhouette, closed.
    static func body(in rect: CGRect) -> CGPath { path(bodyData, in: rect) }

    /// The eye, a circle to cut out of the body (use even-odd fill).
    static func eye(in rect: CGRect) -> CGPath {
        let f = fit(rect)
        let r = CGRect(x: \(String(format: "%.4f", ecx - erx)), y: \(String(format: "%.4f", ecy - ery)), width: \(String(format: "%.4f", erx * 2)), height: \(String(format: "%.4f", ery * 2)))
        return CGPath(ellipseIn: r.applying(f), transform: nil)
    }

    /// The thin wing line, a closed sliver to cut out of the body (use even-odd fill).
    static func wing(in rect: CGRect) -> CGPath { path(wingData, in: rect) }

    /// Maps the unit box into `rect`, aspect-preserving and centred.
    private static func fit(_ rect: CGRect) -> CGAffineTransform {
        let w = min(rect.width, rect.height * aspect), h = w / aspect
        return CGAffineTransform(translationX: rect.midX - w / 2, y: rect.midY - h / 2).scaledBy(x: w, y: h)
    }

    /// Data layout: move x y, then (c1x c1y c2x c2y x y) per segment; closed.
    private static func path(_ d: [CGFloat], in rect: CGRect) -> CGPath {
        let p = CGMutablePath()
        guard d.count >= 8 else { return p }
        let t = fit(rect)
        p.move(to: CGPoint(x: d[0], y: d[1]).applying(t))
        var i = 2
        while i + 5 < d.count {
            p.addCurve(
                to: CGPoint(x: d[i + 4], y: d[i + 5]).applying(t),
                control1: CGPoint(x: d[i], y: d[i + 1]).applying(t),
                control2: CGPoint(x: d[i + 2], y: d[i + 3]).applying(t))
            i += 6
        }
        p.closeSubpath()
        return p
    }

    private static let bodyData: [CGFloat] = [
\(fmt(body))
    ]

    private static let wingData: [CGFloat] = [
\(fmt(wing))
    ]
}

"""
try code.write(toFile: outPath, atomically: true, encoding: .utf8)
print("wrote \(outPath): body \(body.count / 6) segments, wing \(wing.count / 6), eye r=\(erx)")
