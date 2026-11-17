import Testing
@testable import SqueakMacCore

@Suite struct LogoColoursTests {
    /// Greenroom-like: deep green square (#1F4D2A), a white "G"-ish glyph, a lime dot (#8DC63F), antialiased edges.
    private func greenroom(softEdges: Bool) -> [UInt8] {
        let bg = (0x1F, 0x4D, 0x2A), white = (255, 255, 255), lime = (0x8D, 0xC6, 0x3F)
        func kind(_ x: Int, _ y: Int) -> Int {
            let dx = Double(x) - 24.5, dy = Double(y) - 6.5
            if dx * dx + dy * dy <= 9 { return 2 }
            if x >= 9 && x < 21 && y >= 8 && y < 24 { return 1 }
            return 0
        }
        var out: [UInt8] = []
        for y in 0..<32 { for x in 0..<32 {
            let k = kind(x, y)
            var c = k == 0 ? bg : k == 1 ? white : lime
            if softEdges {
                // Blend with the neighbours' average so every boundary pixel is an in-between colour.
                var r = 0, g = 0, b = 0, n = 0
                for (ox, oy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let nx = min(max(x + ox, 0), 31), ny = min(max(y + oy, 0), 31), nk = kind(nx, ny)
                    let p = nk == 0 ? bg : nk == 1 ? white : lime
                    r += p.0; g += p.1; b += p.2; n += 1
                }
                c = (r / n, g / n, b / n)
            }
            out += [UInt8(c.0), UInt8(c.1), UInt8(c.2), 255]
        } }
        return out
    }

    private func distance(_ a: PondTint.RGB, _ hex: UInt32) -> Double {
        let b = PondTint.RGB(hex: hex)
        return ((a.r - b.r) * (a.r - b.r) + (a.g - b.g) * (a.g - b.g) + (a.b - b.b) * (a.b - b.b)).squareRoot() * 255
    }

    @Test(arguments: [false, true]) func greenroomGivesTheGreenAndTheLimeNotWhite(softEdges: Bool) {
        let colours = LogoColours.colours(rgba: greenroom(softEdges: softEdges), width: 32, height: 32).map(\.rgb)
        #expect(colours.count >= 2 && colours.count <= 3, "\(colours.map(\.hexString))")
        #expect(distance(colours[0], 0x8DC63F) < 12, "accent \(colours[0].hexString)")
        #expect(colours.contains { distance($0, 0x1F4D2A) < 12 }, "\(colours.map(\.hexString))")
        #expect(!colours.contains { min($0.r, $0.g, $0.b) > 0.85 })
    }

    @Test func greyscaleAndBlankGiveNothing() {
        var b: [UInt8] = []
        for v: UInt8 in [10, 128, 250] { for _ in 0..<20 { b += [v, v, v, 255] } }
        #expect(LogoColours.colours(rgba: b, width: 60, height: 1).isEmpty)
        #expect(LogoColours.colours(rgba: [], width: 0, height: 0).isEmpty)
    }

    @Test func transparentPixelsAreIgnored() {
        var b: [UInt8] = []
        for _ in 0..<40 { b += [200, 40, 40, 0] }
        for _ in 0..<40 { b += [0x2B, 0x6C, 0xB0, 255] }
        let c = LogoColours.colours(rgba: b, width: 80, height: 1)
        #expect(c.count == 1)
        #expect(distance(c[0].rgb, 0x2B6CB0) < 2)
    }

    @Test func storageRoundTrip() {
        let c = PondTint.RGB(hex: 0x8DC63F)
        let stored = PondColours.value(colour: c)
        #expect(stored == "#8dc63f")
        #expect(PondColours.isLogoValue(stored))
        #expect(PondColours.seed(named: stored) == .colour(c))
        #expect(PondColours.seed(named: "#8DC63F") == .colour(c))
        #expect(PondColours.seed(named: "#8dc63") == nil)
        // Older saved values still read.
        #expect(PondColours.seed(named: "green") == .hue(140))
        #expect(PondColours.seed(named: "hue:200") == .hue(200))
        #expect(PondColours.seed(named: nil) == nil)
        #expect(PondColours.legacyHueValue(for: "#8dc63f") == "hue:85")
        #expect(PondColours.legacyHueValue(for: "green") == nil)
    }

    @Test func softTintKeepsTheLogoColourHue() {
        let src = PondTint.RGB(hex: 0x1F4D2A)
        for dark in [true, false] {
            let t = PondTint.rgb(seed: .colour(src), dark: dark)
            #expect(abs(PondTint.hsv(t).h - PondTint.hsv(src).h) < 8)
        }
    }
}

#if canImport(CoreGraphics) && canImport(ImageIO)
import CoreGraphics
import Foundation
import ImageIO

@Suite struct LogoColoursRealIconTests {
    /// The real greenroom icon (white "G" on deep green, small lime dot), downsampled to 32x32 the way the Mac app does.
    @Test func greenroomIconGivesDeepGreenAndLime() throws {
        let url = try #require(Bundle.module.url(forResource: "greenroom", withExtension: "png", subdirectory: "icons"))
        let src = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        let img = try #require(CGImageSourceCreateImageAtIndex(src, 0, nil))
        let n = 32
        var bytes = [UInt8](repeating: 0, count: n * n * 4)
        let ok: Bool = bytes.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: n, height: n))
            return true
        }
        #expect(ok)
        let colours = LogoColours.colours(rgba: bytes, width: n, height: n)
        let hexes = colours.map { "\($0.rgb.hexString) share=\($0.share)" }
        #expect(colours.count >= 2, "\(hexes)")
        #expect(colours.contains { $0.rgb.g > 0.65 && $0.rgb.r > 0.3 && $0.rgb.b < 0.45 }, "lime missing: \(hexes)")
        #expect(colours.contains { $0.rgb.g < 0.4 && $0.rgb.r < 0.25 && $0.rgb.g > $0.rgb.r }, "deep green missing: \(hexes)")
    }
}
#endif
