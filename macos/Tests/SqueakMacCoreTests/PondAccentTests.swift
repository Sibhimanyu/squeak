import Testing
@testable import SqueakMacCore

@Suite struct PondAccentTests {
    private func buf(_ px: [(UInt8, UInt8, UInt8, UInt8, Int)]) -> (bytes: [UInt8], w: Int, h: Int) {
        var b: [UInt8] = []
        for (r, g, bl, a, n) in px { for _ in 0..<n { b += [r, g, bl, a] } }
        return (b, b.count / 4, 1)
    }

    @Test func darkGreenIconWithLimeDotGivesTheLime() {
        let i = buf([(0, 90, 40, 255, 60), (170, 230, 20, 255, 20), (0, 0, 0, 0, 20)])
        let hue = PondAccent.vividHue(rgba: i.bytes, width: i.w, height: i.h)
        #expect(hue != nil && hue! >= 75 && hue! < 105)
    }

    @Test func aPlainGreenIconStaysGreen() {
        let i = buf([(30, 160, 80, 255, 50), (255, 255, 255, 255, 10)])
        let hue = PondAccent.vividHue(rgba: i.bytes, width: i.w, height: i.h)
        #expect(hue != nil && abs(hue! - 146) < 15)
    }

    @Test func greyscaleAndBlankGiveNothing() {
        let i = buf([(10, 10, 10, 255, 20), (128, 128, 128, 255, 20), (250, 250, 250, 255, 20)])
        #expect(PondAccent.vividHue(rgba: i.bytes, width: i.w, height: i.h) == nil)
        #expect(PondAccent.vividHue(rgba: [], width: 0, height: 0) == nil)
    }

    @Test func yellowIsNudgedOutOfTheDuckBand() {
        let i = buf([(240, 200, 20, 255, 40)])
        let hue = PondAccent.vividHue(rgba: i.bytes, width: i.w, height: i.h)!
        #expect(!PondTint.duckBand.contains(hue))
    }

    @Test func theAccentIsVividAndKeepsContrastOnBothCards() {
        for hue in stride(from: 0.0, to: 360.0, by: 15) {
            let light = PondAccent.rgb(hue: hue, dark: false)
            let dark = PondAccent.rgb(hue: hue, dark: true)
            #expect(PondTint.contrast(light, PondAccent.lightSurface) >= PondAccent.minContrast, "light \(hue)")
            #expect(PondTint.contrast(dark, PondAccent.darkSurface) >= PondAccent.minContrast, "dark \(hue)")
        }
    }

    @Test func limeIsGreenNotGrey() {
        // The old tint at a lime hue was a pale wash (saturation 0.28); the accent keeps its colour.
        let c = PondAccent.rgb(hue: 90, dark: true)
        let mx = max(c.r, c.g, c.b), mn = min(c.r, c.g, c.b)
        #expect((mx - mn) / mx > 0.6)
        #expect(c.g > c.r && c.g > c.b)
    }

    @Test func syntheticGreenroomIconKeepsTheLime() {
        // 32x32: dark green field, white glyph, small lime dot (#8DC63F).
        var b: [UInt8] = []
        for i in 0..<1024 {
            let x = i % 32, y = i / 32
            if x >= 24 && x < 28 && y >= 4 && y < 8 { b += [0x8D, 0xC6, 0x3F, 255] }
            else if x >= 10 && x < 20 && y >= 8 && y < 24 { b += [255, 255, 255, 255] }
            else { b += [0x1F, 0x4A, 0x28, 255] }
        }
        let hue = PondAccent.vividHue(rgba: b, width: 32, height: 32)!
        #expect(abs(hue - 88) < 15, "hue \(hue)")
        for dark in [true, false] {
            let c = PondAccent.rgb(hue: hue, dark: dark)
            let mx = max(c.r, c.g, c.b), mn = min(c.r, c.g, c.b), d = mx - mn
            var h = (mx == c.r ? ((c.g - c.b) / d).truncatingRemainder(dividingBy: 6) : mx == c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4) * 60
            if h < 0 { h += 360 }
            #expect(abs(h - 88) < 15, "accent hue \(h) dark \(dark)")
        }
    }
}
