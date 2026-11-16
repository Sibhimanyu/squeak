import Testing
@testable import SqueakMacCore

@Suite struct PondAccentTests {
    private func buf(_ px: [(UInt8, UInt8, UInt8, UInt8, Int)]) -> (bytes: [UInt8], w: Int, h: Int) {
        var b: [UInt8] = []
        for (r, g, bl, a, n) in px { for _ in 0..<n { b += [r, g, bl, a] } }
        return (b, b.count / 4, 1)
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

    @Test func aRealColourKeepsItsHueAndSaturationWhileMeetingContrast() {
        for hex: UInt32 in [0x8DC63F, 0x1F4D2A, 0x2B6CB0, 0xE53E3E, 0x805AD5, 0xF6E05E, 0x1A202C] {
            let src = PondTint.RGB(hex: hex)
            let (h0, s0, _) = PondTint.hsv(src)
            for dark in [true, false] {
                let c = PondAccent.rgb(seed: .colour(src), dark: dark)
                #expect(PondTint.contrast(c, dark ? PondAccent.darkSurface : PondAccent.lightSurface) >= PondAccent.minContrast - 0.01, "\(hex) dark \(dark)")
                let (h, s, _) = PondTint.hsv(c)
                var dh = abs(h - h0); dh = min(dh, 360 - dh)
                #expect(dh < 6, "hue \(hex) dark \(dark): \(h0) -> \(h)")
                #expect(abs(s - s0) < 0.12, "sat \(hex) dark \(dark): \(s0) -> \(s)")
            }
        }
    }

    @Test func aColourAlreadyLegibleIsUntouched() {
        let src = PondTint.RGB(hex: 0x2B6CB0)
        #expect(PondAccent.rgb(seed: .colour(src), dark: false) == src)
    }

    @Test func limeOnLightMovesOnlyInValue() {
        let src = PondTint.RGB(hex: 0x8DC63F)
        let c = PondAccent.rgb(seed: .colour(src), dark: false)
        #expect(PondTint.hsv(c).v < PondTint.hsv(src).v)
        #expect(c.g > c.r && c.g > c.b)
    }
}
