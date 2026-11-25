import Foundation

// DESIGN.md §3.5, "Pond tint": the open pond's accent (`PondAccent`) as a faint wash where the person is working. Pure
// colour maths: the role's opacity per appearance, the blend over the neutral ground, and a contrast guard so text on a
// washed ground stays AA. Body text is never tinted; a surface with no pond keeps today's neutral.

public enum PondWash {
    /// Where the tint shows. Each role has its own opacity, per appearance (dark takes a little more: a wash on a deep
    /// ground is quieter than on a pale one).
    public enum Role: CaseIterable, Sendable {
        /// The selected thread row's fill, laid over `selected`.
        case selectedRow
        /// The open pond's header row in the sidebar, over `selected`.
        case pondHeader
        /// The top surface where there is no Duck subheader: the quiet tint, fading to nothing over `duckFadeHeight`.
        case workbenchTop
        /// The top area's surface (bar and Duck subheader as one): the Pond's quiet tint at the top edge, fading into the chat
        /// ground over `duckFadeHeight` (about 120 pt, `PondWash.duckFade`). Never a loud band: see `PondQuietTint`.
        case duckTop
        /// The selected tab's 2 pt underline (a line, not a wash: the accent itself, already 3:1 on the card).
        case tabIndicator
        /// The composer's focus ring.
        case focusRing

        public func opacity(dark: Bool) -> Double {
            switch self {
            // Washes lie as the Pond's quiet tint (`PondQuietTint`: chroma and lightness capped), so these are opacities of a
            // colour that already sits next to its ground.
            case .selectedRow: dark ? 0.5 : 0.45
            case .pondHeader: dark ? 0.45 : 0.4
            case .workbenchTop, .duckTop: PondQuietTint.maxOpacity(dark: dark)
            case .tabIndicator: 1.0
            case .focusRing: dark ? 0.55 : 0.45
            }
        }

        /// The neutral ground the wash lies on (nil for a line or ring, which has no ground of its own).
        public func ground(dark: Bool) -> PondTint.RGB? {
            switch self {
            case .selectedRow, .pondHeader: PondTint.RGB(hex: dark ? Tokens.Dark.selected : Tokens.Light.selected)
            case .workbenchTop, .duckTop: PondTint.RGB(hex: dark ? Tokens.Dark.bg : Tokens.Light.bg)
            case .tabIndicator, .focusRing: nil
            }
        }
    }

    /// How far down a Duck page the wash reaches, in points: it fades out over this, with no band edge.
    public static let duckFadeHeight = PondQuietTint.fadeHeight

    /// The wash's strength at `fraction` (0 top, 1 end) of the fade: a smooth ease-out (smootherstep), 1 at the top, exactly 0 and
    /// flat at the end, so the gradient has no visible edge where it stops.
    public static func duckFade(at fraction: Double) -> Double {
        let t = min(max(fraction, 0), 1)
        // Quadratic ease-out: strongest at the very top (no flat shoulder), flat at the end.
        return (1 - t) * (1 - t)
    }

    /// Text that must stay readable on a wash: ink and muted (WCAG 2 AA, 4.5:1).
    public static let minTextContrast = 4.5

    /// `top` over `ground` at `opacity`, plain sRGB source-over.
    public static func blend(_ top: PondTint.RGB, over ground: PondTint.RGB, opacity: Double) -> PondTint.RGB {
        let a = min(max(opacity, 0), 1)
        return PondTint.RGB(r: top.r * a + ground.r * (1 - a), g: top.g * a + ground.g * (1 - a), b: top.b * a + ground.b * (1 - a))
    }

    /// The accent for a pond hue in this appearance (the logo's vivid colour, kept 3:1 on the card).
    public static func accent(hue: Double, dark: Bool) -> PondTint.RGB { PondAccent.rgb(hue: hue, dark: dark) }

    public static func accent(seed: PondSeed, dark: Bool) -> PondTint.RGB { PondAccent.rgb(seed: seed, dark: dark) }

    /// The opacity a role actually uses: the role's own, lowered in steps until ink and muted stay AA on the washed
    /// ground. A role without a ground (the line, the ring) is returned as it is.
    public static func opacity(_ role: Role, accent: PondTint.RGB, dark: Bool) -> Double {
        var o = role.opacity(dark: dark)
        guard let ground = role.ground(dark: dark) else { return o }
        let ink = PondTint.RGB(hex: dark ? Tokens.Dark.ink : Tokens.Light.ink)
        let muted = PondTint.RGB(hex: dark ? Tokens.Dark.muted : Tokens.Light.muted)
        while o > 0 {
            let w = blend(accent, over: ground, opacity: o)
            // The ground the text really sits on: `selected` already carries muted at its own measure (§3.4), so the
            // guard is "no worse than AA", never "better than the neutral".
            if PondTint.contrast(ink, w) >= minTextContrast, PondTint.contrast(muted, w) >= minTextContrast { return o }
            o -= 0.01
        }
        return 0
    }

    /// The colour a wash role lays down: the Pond's quiet tint on the role's ground; nil when the role has no ground.
    public static func quiet(_ role: Role, seed: PondSeed, dark: Bool) -> PondTint.RGB? {
        role.ground(dark: dark).map { PondQuietTint.rgb(seed: seed, dark: dark, ground: $0) }
    }

    /// The blended colour of a wash role for a pond seed; nil when the role has no ground.
    public static func washed(_ role: Role, seed: PondSeed, dark: Bool) -> PondTint.RGB? {
        guard let ground = role.ground(dark: dark), let q = quiet(role, seed: seed, dark: dark) else { return nil }
        return blend(q, over: ground, opacity: opacity(role, accent: q, dark: dark))
    }

    /// The blended colour of a wash role for a pond hue; nil when the role has no ground.
    public static func washed(_ role: Role, hue: Double, dark: Bool) -> PondTint.RGB? { washed(role, seed: .hue(hue), dark: dark) }
}
