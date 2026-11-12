import Testing
@testable import SqueakMacCore

@Suite struct LogoPaletteTests {
    private func buf(_ px: [(UInt8, UInt8, UInt8, UInt8, Int)]) -> (bytes: [UInt8], w: Int, h: Int) {
        var b: [UInt8] = []
        for (r, g, bl, a, n) in px { for _ in 0..<n { b += [r, g, bl, a] } }
        return (b, b.count / 4, 1)
    }

    @Test func greenFirstThenLime() {
        let i = buf([(0, 90, 40, 255, 60), (170, 230, 20, 255, 20), (255, 255, 255, 255, 30), (0, 0, 0, 0, 40)])
        let hues = LogoPalette.hues(rgba: i.bytes, width: i.w, height: i.h)
        #expect(hues.count == 2)
        #expect(abs(hues[0] - 146) < 12)
        #expect(hues[1] >= 75 && hues[1] < 100)
    }

    @Test func greyscaleIsEmpty() {
        let i = buf([(10, 10, 10, 255, 20), (128, 128, 128, 255, 20), (250, 250, 250, 255, 20), (200, 40, 40, 20, 50)])
        #expect(LogoPalette.hues(rgba: i.bytes, width: i.w, height: i.h).isEmpty)
    }

    @Test func yellowIsNudgedOutOfTheDuckBand() {
        let i = buf([(255, 215, 0, 255, 50)])
        let hues = LogoPalette.hues(rgba: i.bytes, width: i.w, height: i.h)
        #expect(hues.count == 1)
        #expect(!PondTint.duckBand.contains(hues[0]))
    }

    @Test func closeHuesMerge() {
        let i = buf([(200, 0, 0, 255, 40), (200, 40, 0, 255, 10), (0, 0, 200, 255, 20)])
        #expect(LogoPalette.hues(rgba: i.bytes, width: i.w, height: i.h).count == 2)
    }

    @Test func hueValuesParse() {
        #expect(PondColours.hue(named: "hue:140") == 140)
        #expect(PondColours.hue(named: "hue:50") != 50)
        #expect(PondColours.hue(named: "hue:400") == nil)
        #expect(PondColours.hue(named: "mauve") == nil)
        #expect(PondColours.hue(named: "teal") == 175)
        #expect(PondColours.value(hue: 140.4) == "hue:140")
    }
}
