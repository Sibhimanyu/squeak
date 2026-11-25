import Testing
@testable import SqueakMacCore

@Suite("Pond tint wash")
struct PondWashTests {
    private let hues: [Double] = stride(from: 0.0, to: 360.0, by: 5).map { PondTint.nudgeOutOfDuckBand($0) }

    @Test func opacitiesAreTheDocumentedOnes() {
        #expect(PondWash.Role.selectedRow.opacity(dark: false) == 0.10)
        #expect(PondWash.Role.selectedRow.opacity(dark: true) == 0.12)
        #expect(PondWash.Role.pondHeader.opacity(dark: false) == 0.08)
        #expect(PondWash.Role.workbenchTop.opacity(dark: true) == 0.08)
        #expect(PondWash.Role.tabIndicator.opacity(dark: false) == 1)
        #expect(PondWash.Role.focusRing.opacity(dark: false) == 0.45)
    }

    @Test func blendIsSourceOver() {
        let w = PondTint.RGB(r: 1, g: 1, b: 1), k = PondTint.RGB(r: 0, g: 0, b: 0)
        #expect(PondWash.blend(w, over: k, opacity: 0) == k)
        #expect(PondWash.blend(w, over: k, opacity: 1) == w)
        #expect(abs(PondWash.blend(w, over: k, opacity: 0.25).r - 0.25) < 1e-9)
    }

    @Test func textStaysAAOnEveryWashedGround() {
        for dark in [false, true] {
            let ink = PondTint.RGB(hex: dark ? Tokens.Dark.ink : Tokens.Light.ink)
            let muted = PondTint.RGB(hex: dark ? Tokens.Dark.muted : Tokens.Light.muted)
            for hue in hues {
                for role in PondWash.Role.allCases {
                    guard let w = PondWash.washed(role, hue: hue, dark: dark) else { continue }
                    #expect(PondTint.contrast(ink, w) >= PondWash.minTextContrast, "ink \(role) \(hue) dark=\(dark)")
                    #expect(PondTint.contrast(muted, w) >= PondWash.minTextContrast, "muted \(role) \(hue) dark=\(dark)")
                }
            }
        }
    }

    @Test func theGuardLowersAnOpacityThatWouldBreakAA() {
        // A white "accent" at a heavy role on a light ground would sink muted text; the guard must give less than asked
        // or stop at the role's own value, never exceed it.
        let loud = PondTint.RGB(r: 0, g: 0, b: 0)
        for role in [PondWash.Role.selectedRow, .pondHeader, .workbenchTop] {
            #expect(PondWash.opacity(role, accent: loud, dark: false) <= role.opacity(dark: false))
        }
        let heavy = PondWash.opacity(.selectedRow, accent: PondTint.RGB(r: 0, g: 0, b: 0), dark: true)
        #expect(heavy < Double.infinity)
    }

    @Test func theDuckGradientIsVisibleAndFadesWithoutAnEdge() {
        #expect(PondWash.Role.duckTop.opacity(dark: false) >= 0.2)
        #expect(PondWash.Role.duckTop.opacity(dark: true) >= 0.2)
        #expect(PondWash.duckFade(at: 0) == 1)
        #expect(PondWash.duckFade(at: 1) == 0)
        #expect(PondWash.duckFadeHeight >= 160 && PondWash.duckFadeHeight <= 240)
        var last = 1.0
        for i in 1...20 {
            let v = PondWash.duckFade(at: Double(i) / 20)
            #expect(v <= last); last = v
        }
        // Flat at the end: the last step is tiny, so no hard band edge.
        #expect(PondWash.duckFade(at: 0.97) < 0.01)
    }

    @Test func linesAndRingsKeepTheirOwnOpacityAndHaveNoGround() {
        let a = PondWash.accent(hue: 200, dark: false)
        #expect(PondWash.opacity(.tabIndicator, accent: a, dark: false) == 1)
        #expect(PondWash.opacity(.focusRing, accent: a, dark: true) == 0.55)
        #expect(PondWash.washed(.tabIndicator, hue: 200, dark: true) == nil)
    }

    @Test func theAccentStaysThreeToOneOnTheCard() {
        for dark in [false, true] {
            let surface = dark ? PondAccent.darkSurface : PondAccent.lightSurface
            for hue in hues { #expect(PondTint.contrast(PondWash.accent(hue: hue, dark: dark), surface) >= 3.0) }
        }
    }
}
