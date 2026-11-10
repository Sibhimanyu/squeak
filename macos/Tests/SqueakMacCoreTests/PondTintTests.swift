import Testing
@testable import SqueakMacCore

@Suite("Pond tint")
struct PondTintTests {
    private let ids = (0..<400).map { "pond-\($0)-\($0 * 7919)" }

    @Test func aPondAlwaysGetsTheSameTint() {
        for id in ids.prefix(20) {
            #expect(PondTint.hue(for: id) == PondTint.hue(for: id))
            #expect(PondTint.rgb(for: id, dark: true) == PondTint.rgb(for: id, dark: true))
        }
        #expect(Set(ids.map { Int(PondTint.hue(for: $0) / 30) }).count >= 8)
    }

    @Test func noHueEverLandsInTheDucksBand() {
        for id in ids { #expect(!PondTint.duckBand.contains(PondTint.hue(for: id))) }
        for raw in stride(from: 0.0, to: 335.0, by: 1) { #expect(!PondTint.duckBand.contains(PondTint.skipDuck(raw))) }
        #expect(PondTint.avatarHues.allSatisfy { !PondTint.duckBand.contains($0) })
    }

    @Test func inkReadsOnEveryTintInLightAndDark() {
        let lightInk = PondTint.RGB(hex: Tokens.Light.ink), darkInk = PondTint.RGB(hex: Tokens.Dark.ink)
        for id in ids {
            #expect(PondTint.contrast(PondTint.rgb(for: id, dark: false), lightInk) >= 4.5)
            #expect(PondTint.contrast(PondTint.rgb(for: id, dark: true), darkInk) >= 4.5)
        }
        for i in 0..<6 {
            #expect(PondTint.contrast(PondTint.avatar(index: i, dark: false), lightInk) >= 4.5)
            #expect(PondTint.contrast(PondTint.avatar(index: i, dark: true), darkInk) >= 4.5)
        }
    }

    @Test func theDuckAccentPassesNonTextContrastWhereItIsUsed() {
        // Dark: duck on the Mac surface. Light: duck-text (duck itself fails on light, §3.4).
        #expect(PondTint.contrast(PondTint.RGB(hex: Tokens.duck), PondTint.RGB(hex: Tokens.Dark.surface)) >= 3)
        #expect(PondTint.contrast(PondTint.RGB(hex: Tokens.duckText), PondTint.RGB(hex: Tokens.Light.surface)) >= 4.5)
        #expect(PondTint.contrast(PondTint.RGB(hex: Tokens.duckText), PondTint.RGB(hex: Tokens.Light.selected)) >= 4.5)
        // A primary button's label: ink on duck.
        #expect(PondTint.contrast(PondTint.RGB(hex: Tokens.duckOutline), PondTint.RGB(hex: Tokens.duck)) >= 4.5)
        // And duck on a light ground is the failure the rule exists for.
        #expect(PondTint.contrast(PondTint.RGB(hex: Tokens.duck), PondTint.RGB(hex: Tokens.Light.surface)) < 3)
    }

    @Test func aTintIsSoftNotLoud() {
        for id in ids.prefix(50) {
            let l = PondTint.rgb(for: id, dark: false)
            #expect(PondTint.luminance(l) > 0.45)
            let d = PondTint.rgb(for: id, dark: true)
            #expect(PondTint.luminance(d) < 0.1)
        }
    }
}
