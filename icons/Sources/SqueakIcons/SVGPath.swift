import CoreGraphics
import Foundation

/// One absolute drawing command. Everything in an SVG path (relative moves,
/// shorthand curves, arcs) is reduced to these four.
public enum PathCommand: Equatable, Sendable {
    case move(CGPoint)
    case line(CGPoint)
    case cubic(CGPoint, CGPoint, CGPoint)  // control 1, control 2, end
    case close
}

/// A small SVG path-data parser: M L H V C S Q T A Z, absolute and relative.
public enum SVGPath {
    public static func commands(_ d: String) -> [PathCommand] {
        var scanner = Scanner(d)
        var out: [PathCommand] = []
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastCubicControl: CGPoint?  // for S
        var lastQuadControl: CGPoint?  // for T
        var cmd: Character = " "

        while true {
            scanner.skipSeparators()
            if scanner.atEnd { break }
            if let c = scanner.peekCommand() {
                cmd = c
                scanner.advance()
                if c == "Z" || c == "z" {
                    out.append(.close)
                    cur = start
                    lastCubicControl = nil
                    lastQuadControl = nil
                    continue
                }
            } else if cmd == " " || cmd == "Z" || cmd == "z" {
                break  // numbers with no command: malformed
            }
            let rel = cmd.isLowercase
            let ox = rel ? cur.x : 0, oy = rel ? cur.y : 0
            var nextCubic: CGPoint?
            var nextQuad: CGPoint?

            switch cmd.uppercased() {
            case "M":
                guard let x = scanner.number(), let y = scanner.number() else { return out }
                cur = CGPoint(x: x + ox, y: y + oy)
                start = cur
                out.append(.move(cur))
                cmd = rel ? "l" : "L"  // implicit repeats are lineto
            case "L":
                guard let x = scanner.number(), let y = scanner.number() else { return out }
                cur = CGPoint(x: x + ox, y: y + oy)
                out.append(.line(cur))
            case "H":
                guard let x = scanner.number() else { return out }
                cur = CGPoint(x: x + ox, y: cur.y)
                out.append(.line(cur))
            case "V":
                guard let y = scanner.number() else { return out }
                cur = CGPoint(x: cur.x, y: y + oy)
                out.append(.line(cur))
            case "C":
                guard let a = scanner.number(), let b = scanner.number(),
                    let c = scanner.number(), let e = scanner.number(),
                    let x = scanner.number(), let y = scanner.number()
                else { return out }
                let p1 = CGPoint(x: a + ox, y: b + oy)
                let p2 = CGPoint(x: c + ox, y: e + oy)
                cur = CGPoint(x: x + ox, y: y + oy)
                out.append(.cubic(p1, p2, cur))
                nextCubic = p2
            case "S":
                guard let c = scanner.number(), let e = scanner.number(),
                    let x = scanner.number(), let y = scanner.number()
                else { return out }
                let p1 = lastCubicControl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let p2 = CGPoint(x: c + ox, y: e + oy)
                cur = CGPoint(x: x + ox, y: y + oy)
                out.append(.cubic(p1, p2, cur))
                nextCubic = p2
            case "Q":
                guard let a = scanner.number(), let b = scanner.number(),
                    let x = scanner.number(), let y = scanner.number()
                else { return out }
                let q = CGPoint(x: a + ox, y: b + oy)
                let end = CGPoint(x: x + ox, y: y + oy)
                out.append(quad(from: cur, control: q, to: end))
                cur = end
                nextQuad = q
            case "T":
                guard let x = scanner.number(), let y = scanner.number() else { return out }
                let q = lastQuadControl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let end = CGPoint(x: x + ox, y: y + oy)
                out.append(quad(from: cur, control: q, to: end))
                cur = end
                nextQuad = q
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(),
                    let rot = scanner.number(), let large = scanner.flag(),
                    let sweep = scanner.flag(), let x = scanner.number(), let y = scanner.number()
                else { return out }
                let end = CGPoint(x: x + ox, y: y + oy)
                out.append(
                    contentsOf: arc(
                        from: cur, to: end, rx: rx, ry: ry, rotation: rot,
                        largeArc: large, sweep: sweep))
                cur = end
            default:
                return out  // unknown command
            }
            lastCubicControl = nextCubic
            lastQuadControl = nextQuad
        }
        return out
    }

    private static func quad(from p0: CGPoint, control q: CGPoint, to p2: CGPoint) -> PathCommand {
        let c1 = CGPoint(x: p0.x + 2.0 / 3 * (q.x - p0.x), y: p0.y + 2.0 / 3 * (q.y - p0.y))
        let c2 = CGPoint(x: p2.x + 2.0 / 3 * (q.x - p2.x), y: p2.y + 2.0 / 3 * (q.y - p2.y))
        return .cubic(c1, c2, p2)
    }

    /// SVG implementation notes F.6.5: endpoint to centre parameterisation,
    /// then one cubic per arc of at most 90 degrees.
    static func arc(
        from p0: CGPoint, to p1: CGPoint, rx rxIn: Double, ry ryIn: Double,
        rotation: Double, largeArc: Bool, sweep: Bool
    ) -> [PathCommand] {
        var rx = abs(rxIn), ry = abs(ryIn)
        if p0 == p1 { return [] }
        if rx == 0 || ry == 0 { return [.line(p1)] }
        let phi = rotation * .pi / 180
        let cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1p = cosP * dx + sinP * dy
        let y1p = -sinP * dx + cosP * dy
        let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if lambda > 1 {
            let s = lambda.squareRoot()
            rx *= s
            ry *= s
        }
        let num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
        let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
        var coef = den == 0 ? 0 : (max(0, num) / den).squareRoot()
        if largeArc == sweep { coef = -coef }
        let cxp = coef * (rx * y1p / ry)
        let cyp = coef * -(ry * x1p / rx)
        let cx = cosP * cxp - sinP * cyp + (p0.x + p1.x) / 2
        let cy = sinP * cxp + cosP * cyp + (p0.y + p1.y) / 2

        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        }
        let theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }

        let segments = max(1, Int((abs(delta) / (.pi / 2) - 1e-9).rounded(.up)))
        let step = delta / Double(segments)
        let t = 4.0 / 3 * tan(step / 4)
        var out: [PathCommand] = []
        var a = theta1
        func point(_ ang: Double) -> CGPoint {
            let x = rx * cos(ang), y = ry * sin(ang)
            return CGPoint(x: cosP * x - sinP * y + cx, y: sinP * x + cosP * y + cy)
        }
        func deriv(_ ang: Double) -> CGPoint {
            let x = -rx * sin(ang), y = ry * cos(ang)
            return CGPoint(x: cosP * x - sinP * y, y: sinP * x + cosP * y)
        }
        for i in 0..<segments {
            let b = a + step
            let s = point(a), e = (i == segments - 1) ? p1 : point(b)
            let ds = deriv(a), de = deriv(b)
            out.append(
                .cubic(
                    CGPoint(x: s.x + t * ds.x, y: s.y + t * ds.y),
                    CGPoint(x: e.x - t * de.x, y: e.y - t * de.y), e))
            a = b
        }
        return out
    }

    // MARK: Basic shapes as commands

    static func ellipse(cx: Double, cy: Double, rx: Double, ry: Double) -> [PathCommand] {
        let k = 0.5522847498307936
        let kx = rx * k, ky = ry * k
        return [
            .move(CGPoint(x: cx + rx, y: cy)),
            .cubic(CGPoint(x: cx + rx, y: cy + ky), CGPoint(x: cx + kx, y: cy + ry), CGPoint(x: cx, y: cy + ry)),
            .cubic(CGPoint(x: cx - kx, y: cy + ry), CGPoint(x: cx - rx, y: cy + ky), CGPoint(x: cx - rx, y: cy)),
            .cubic(CGPoint(x: cx - rx, y: cy - ky), CGPoint(x: cx - kx, y: cy - ry), CGPoint(x: cx, y: cy - ry)),
            .cubic(CGPoint(x: cx + kx, y: cy - ry), CGPoint(x: cx + rx, y: cy - ky), CGPoint(x: cx + rx, y: cy)),
            .close,
        ]
    }

    static func rect(x: Double, y: Double, width w: Double, height h: Double, rx rxIn: Double, ry ryIn: Double)
        -> [PathCommand]
    {
        let rx = min(max(rxIn, 0), w / 2), ry = min(max(ryIn, 0), h / 2)
        if rx == 0 || ry == 0 {
            return [
                .move(CGPoint(x: x, y: y)), .line(CGPoint(x: x + w, y: y)),
                .line(CGPoint(x: x + w, y: y + h)), .line(CGPoint(x: x, y: y + h)), .close,
            ]
        }
        let k = 0.5522847498307936
        let kx = rx * k, ky = ry * k
        let r = x + w, b = y + h
        return [
            .move(CGPoint(x: x + rx, y: y)),
            .line(CGPoint(x: r - rx, y: y)),
            .cubic(CGPoint(x: r - rx + kx, y: y), CGPoint(x: r, y: y + ry - ky), CGPoint(x: r, y: y + ry)),
            .line(CGPoint(x: r, y: b - ry)),
            .cubic(CGPoint(x: r, y: b - ry + ky), CGPoint(x: r - rx + kx, y: b), CGPoint(x: r - rx, y: b)),
            .line(CGPoint(x: x + rx, y: b)),
            .cubic(CGPoint(x: x + rx - kx, y: b), CGPoint(x: x, y: b - ry + ky), CGPoint(x: x, y: b - ry)),
            .line(CGPoint(x: x, y: y + ry)),
            .cubic(CGPoint(x: x, y: y + ry - ky), CGPoint(x: x + rx - kx, y: y), CGPoint(x: x + rx, y: y)),
            .close,
        ]
    }

    static func poly(_ v: [Double], closed: Bool) -> [PathCommand] {
        var out: [PathCommand] = []
        var i = 0
        while i + 1 < v.count {
            let p = CGPoint(x: v[i], y: v[i + 1])
            out.append(i == 0 ? .move(p) : .line(p))
            i += 2
        }
        if closed && !out.isEmpty { out.append(.close) }
        return out
    }
}

/// Reads numbers the way SVG path data writes them: "1.5.5", "-2-3", "1e-2",
/// and arc flags as single digits with no separator ("a2 2 0 012-2").
private struct Scanner {
    let s: [Character]
    var i = 0
    init(_ str: String) { s = Array(str) }
    var atEnd: Bool { i >= s.count }

    mutating func advance() { i += 1 }
    mutating func skipSeparators() {
        while i < s.count, s[i] == " " || s[i] == "," || s[i] == "\n" || s[i] == "\t" || s[i] == "\r" { i += 1 }
    }
    func peekCommand() -> Character? {
        guard i < s.count else { return nil }
        return "MmLlHhVvCcSsQqTtAaZz".contains(s[i]) ? s[i] : nil
    }
    mutating func flag() -> Bool? {
        skipSeparators()
        guard i < s.count, s[i] == "0" || s[i] == "1" else { return nil }
        defer { i += 1 }
        return s[i] == "1"
    }
    mutating func number() -> Double? {
        skipSeparators()
        let begin = i
        var j = i
        if j < s.count, s[j] == "+" || s[j] == "-" { j += 1 }
        var digits = 0
        while j < s.count, s[j].isASCII, s[j].isNumber { j += 1; digits += 1 }
        if j < s.count, s[j] == "." {
            j += 1
            while j < s.count, s[j].isASCII, s[j].isNumber { j += 1; digits += 1 }
        }
        guard digits > 0 else { return nil }
        if j < s.count, s[j] == "e" || s[j] == "E" {
            var k = j + 1
            if k < s.count, s[k] == "+" || s[k] == "-" { k += 1 }
            if k < s.count, s[k].isNumber {
                while k < s.count, s[k].isNumber { k += 1 }
                j = k
            }
        }
        i = j
        return Double(String(s[begin..<j]))
    }
}
