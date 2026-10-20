import CoreGraphics
import SwiftUI
import Testing

@testable import SqueakIcons

private func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x, y: y) }

@Suite struct ParserTests {
    @Test func absoluteAndRelative() {
        #expect(SVGPath.commands("M1 2L3 4") == [.move(p(1, 2)), .line(p(3, 4))])
        #expect(SVGPath.commands("m1 2l3 4") == [.move(p(1, 2)), .line(p(4, 6))])
        #expect(SVGPath.commands("M1 1h2v3H0V0z") == [
            .move(p(1, 1)), .line(p(3, 1)), .line(p(3, 4)), .line(p(0, 4)), .line(p(0, 0)), .close,
        ])
    }

    @Test func implicitRepeatsAndPackedNumbers() {
        // Extra pairs after M are lineto; relative stays relative.
        #expect(SVGPath.commands("m1 1 2 2 1 1") == [.move(p(1, 1)), .line(p(3, 3)), .line(p(4, 4))])
        #expect(SVGPath.commands("M0 0L1-2.5.5 1") == [.move(p(0, 0)), .line(p(1, -2.5)), .line(p(0.5, 1))])
        #expect(SVGPath.commands("M0,0 L1e1,2E-1") == [.move(p(0, 0)), .line(p(10, 0.2))])
    }

    @Test func closeResetsCurrentPoint() {
        let c = SVGPath.commands("M2 2l2 0z l1 1")
        #expect(c.last == .line(p(3, 3)))
    }

    @Test func smoothAndQuadratic() {
        let c = SVGPath.commands("M0 0C0 1 1 1 1 0S2-1 2 0")
        guard case .cubic(let c1, _, _) = c[2] else { Issue.record("no cubic"); return }
        #expect(c1 == p(1, -1))  // reflection of (1,1) about (1,0)
        let q = SVGPath.commands("M0 0Q3 0 3 3T6 6")
        guard case .cubic(_, _, let e) = q[2] else { Issue.record("no cubic"); return }
        #expect(e == p(6, 6))
    }

    @Test func arcWithPackedFlags() {
        // Lucide writes "a2 2 0 012-2": rx ry rot large=0 sweep=1 x=2 y=-2.
        let c = SVGPath.commands("M3 5a2 2 0 012-2")
        #expect(c.count == 2)
        guard case .cubic(_, _, let e) = c[1] else { Issue.record("no cubic"); return }
        #expect(abs(e.x - 5) < 1e-9 && abs(e.y - 3) < 1e-9)
        // Quarter circle, centre (5,5), sweep=1 (clockwise on screen): bounds stay in the corner.
        let b = SwiftUI.Path { path in
            for cmd in c {
                switch cmd {
                case .move(let a): path.move(to: a)
                case .cubic(let c1, let c2, let e): path.addCurve(to: e, control1: c1, control2: c2)
                default: break
                }
            }
        }.cgPath.boundingBoxOfPath
        #expect(b.minX >= 2.99 && b.maxX <= 5.01 && b.minY >= 2.99 && b.maxY <= 5.01)
    }

    @Test func arcFlagsChooseTheRightArc() {
        // Half circle (0,0) to (2,0), r=1: sweep decides which side of the chord.
        func midY(large: Int, sweep: Int) -> Double {
            let c = SVGPath.commands("M0 0A1 1 0 \(large) \(sweep) 2 0")
            var path = SwiftUI.Path()
            for cmd in c {
                switch cmd {
                case .move(let a): path.move(to: a)
                case .cubic(let c1, let c2, let e): path.addCurve(to: e, control1: c1, control2: c2)
                default: break
                }
            }
            let r = path.cgPath.boundingBoxOfPath
            return abs(r.minY) > abs(r.maxY) ? r.minY : r.maxY
        }
        #expect(midY(large: 0, sweep: 1) < -0.99)  // sweep=1: clockwise, bulges up (y negative)
        #expect(midY(large: 0, sweep: 0) > 0.99)
    }

    @Test func largeArcAndRadiusScaling() {
        // Three-quarter circle, r=1, from (1,0) to (0,1): large arc spans 270 degrees => 3 segments.
        let big = SVGPath.commands("M1 0A1 1 0 1 1 0 1")
        #expect(big.count == 4)
        // Radii too small for the chord are scaled up: ends at the endpoint, one half circle.
        let small = SVGPath.commands("M0 0A0.1 0.1 0 0 1 4 0")
        #expect(small.count == 3)
        guard case .cubic(_, _, let e) = small.last! else { Issue.record("no cubic"); return }
        #expect(e == p(4, 0))
        // Zero radius is a straight line; same point draws nothing.
        #expect(SVGPath.commands("M0 0A0 5 0 0 1 4 4") == [.move(p(0, 0)), .line(p(4, 4))])
        #expect(SVGPath.commands("M1 1A2 2 0 0 1 1 1") == [.move(p(1, 1))])
    }

    @Test func shapes() {
        #expect(LucideElement.rect(x: 1, y: 2, width: 4, height: 6, rx: 0, ry: 0).commands.count == 5)
        let rr = SwiftUI.Path { path in
            for c in LucideElement.rect(x: 2, y: 2, width: 20, height: 20, rx: 4, ry: 4).commands {
                switch c {
                case .move(let a): path.move(to: a)
                case .line(let a): path.addLine(to: a)
                case .cubic(let c1, let c2, let e): path.addCurve(to: e, control1: c1, control2: c2)
                case .close: path.closeSubpath()
                }
            }
        }.boundingRect
        #expect(abs(rr.minX - 2) < 1e-6 && abs(rr.maxX - 22) < 1e-6 && abs(rr.maxY - 22) < 1e-6)
        #expect(LucideElement.polygon([0, 0, 1, 0, 1, 1]).commands.last == .close)
        #expect(LucideElement.polyline([0, 0, 1, 0]).commands.count == 2)
        #expect(LucideElement.line(x1: 0, y1: 0, x2: 3, y2: 4).commands == [.move(p(0, 0)), .line(p(3, 4))])
    }
}

@Suite struct IconDataTests {
    @Test func everyIconDrawsInsideTheGrid() {
        for name in LucideName.allCases {
            let path = name.gridPath
            #expect(!path.isEmpty, "\(name) is empty")
            let b = path.cgPath.boundingBoxOfPath
            #expect(
                b.width > 1 && b.minX >= -0.5 && b.minY >= -0.5 && b.maxX <= 24.5 && b.maxY <= 24.5,
                "\(name) bounds \(b)")
        }
    }

    @Test func namesAreUniqueAndLucideKebab() {
        let raw = LucideName.allCases.map(\.rawValue)
        #expect(Set(raw).count == raw.count)
        #expect(LucideName(rawValue: "square-pen") == .squarePen)
    }

    @Test func shapeFitsFrame() {
        let r = CGRect(x: 0, y: 0, width: 48, height: 48)
        let b = LucideIcon(.search).path(in: r).boundingRect
        #expect(b.minX >= 0 && b.maxX <= 48 && b.width > 30)  // 2x scale of an 18-unit-wide icon
    }
}

#if canImport(AppKit)
import AppKit

@MainActor @Suite struct RenderTests {
    /// Fraction of pixels with any alpha.
    func inkFraction(_ name: LucideName, size: CGFloat) -> Double {
        let r = ImageRenderer(content: Lucide(name, size: size, color: Color.black))
        r.scale = 2
        guard let cg = r.cgImage else { return 0 }
        let w = cg.width, h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(
            data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var ink = 0
        for i in stride(from: 3, to: data.count, by: 4) where data[i] > 16 { ink += 1 }
        return Double(ink) / Double(w * h)
    }

    @Test func renders() {
        for n in [LucideName.search, .gitBranch, .squarePen, .settings, .check] {
            for size in [16.0, 20.0] {
                let f = inkFraction(n, size: size)
                #expect(f > 0.03 && f < 0.6, "\(n) @\(size): \(f)")
            }
        }
    }

    @Test func everyIconRenders() {
        for n in LucideName.allCases { #expect(inkFraction(n, size: 20) > 0.02, "\(n)") }
    }
}
#endif
