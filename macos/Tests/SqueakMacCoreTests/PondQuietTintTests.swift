import Testing
@testable import SqueakMacCore

@Suite("Pond quiet tint")
struct PondQuietTintTests {
    /// The logo colours the owner named: bright yellow, neon green, deep navy, and greenroom's own green.
    private let logos: [(name: String, colour: PondTint.RGB)] = [
        ("bright yellow", PondTint.RGB(hex: 0xFFE600)),
        ("neon green", PondTint.RGB(hex: 0x39FF14)),
        ("deep navy", PondTint.RGB(hex: 0x0A1F5C)),
        ("greenroom green", PondTint.RGB(hex: 0x34A85F)),
        ("hot pink", PondTint.RGB(hex: 0xFF1493)),
    ]

    @Test func chromaIsCappedForEveryLogoColour() {
        for dark in [false, true] {
            let ground = PondQuietTint.ground(dark: dark)
            for logo in logos {
                let q = PondQuietTint.quiet(logo.colour, dark: dark, ground: ground)
                #expect(PondQuietTint.Lch(q).c <= PondQuietTint.maxChroma + 0.003, "\(logo.name) dark=\(dark)")
            }
        }
    }

    @Test func lightnessStaysCloseToTheGround() {
        for dark in [false, true] {
            let ground = PondQuietTint.ground(dark: dark)
            let gl = PondQuietTint.Lch(ground).l
            for logo in logos {
                let l = PondQuietTint.Lch(PondQuietTint.quiet(logo.colour, dark: dark, ground: ground)).l
                #expect(abs(l - gl) <= PondQuietTint.lightnessOffset + 0.01, "\(logo.name) dark=\(dark)")
            }
        }
    }

    @Test func theBlendedTopEdgeIsQuietForEveryLogoColour() {
        for dark in [false, true] {
            let ground = PondQuietTint.ground(dark: dark)
            for logo in logos {
                let peak = PondQuietTint.peak(seed: .colour(logo.colour), dark: dark)
                #expect(PondQuietTint.distance(peak, ground) <= PondQuietTint.maxPeakDistance, "\(logo.name) dark=\(dark)")
                // What is actually on screen is a faint breath of colour: well under the cap.
                #expect(PondQuietTint.Lch(peak).c <= PondQuietTint.maxChroma * PondQuietTint.maxOpacity(dark: dark) + 0.01)
            }
        }
    }

    @Test func aLoudLogoIsNoLouderThanADullOne() {
        // The tint's strength comes from the caps, not from how bright the logo is: yellow and navy land within a hair.
        for dark in [false, true] {
            let ground = PondQuietTint.ground(dark: dark)
            let yellow = PondQuietTint.distance(PondQuietTint.peak(seed: .colour(logos[0].colour), dark: dark), ground)
            let navy = PondQuietTint.distance(PondQuietTint.peak(seed: .colour(logos[2].colour), dark: dark), ground)
            #expect(abs(yellow - navy) < 0.01)
        }
    }

    @Test func theHueSurvivesSoItStillReadsAsThePondsColour() {
        let ground = PondQuietTint.ground(dark: true)
        let green = PondQuietTint.Lch(PondQuietTint.quiet(logos[3].colour, dark: true, ground: ground))
        let source = PondQuietTint.Lch(logos[3].colour)
        var dh = abs(green.h - source.h)
        if dh > .pi { dh = 2 * .pi - dh }
        #expect(dh < 0.35)
    }

    @Test func aGreyLogoStaysNeutral() {
        let q = PondQuietTint.quiet(PondTint.RGB(hex: 0x808080), dark: true, ground: PondQuietTint.ground(dark: true))
        #expect(PondQuietTint.Lch(q).c < 0.01)
    }

    @Test func maximumOpacityIsLowAndTheFadeIsShort() {
        #expect(PondQuietTint.maxOpacity(dark: true) <= 0.6)
        #expect(PondQuietTint.maxOpacity(dark: false) <= 0.6)
        #expect(PondQuietTint.fadeHeight <= 120)
    }

    @Test func everyWashRoleIsQuietToo() {
        for dark in [false, true] {
            for role in PondWash.Role.allCases {
                guard let ground = role.ground(dark: dark) else { continue }
                for logo in logos {
                    guard let w = PondWash.washed(role, seed: .colour(logo.colour), dark: dark) else { continue }
                    #expect(PondQuietTint.distance(w, ground) <= PondQuietTint.maxPeakDistance, "\(role) \(logo.name) dark=\(dark)")
                }
            }
        }
    }
}
