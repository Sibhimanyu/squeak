/// DESIGN.md §11 (the target scale of `.context/UI-SPEC.md` §1.1: opaque, warm near-black; window #141110, sidebar and composer #211E1C, cards #2C2826), as hex values (RGB). The app's `Theme` builds its colours from these, and a test
/// pins them, so a change to the design tokens has to change both on purpose.
public enum Tokens {
    // Brand (§3.1). `duck` is a fill, never text on a light ground; `beak` is never a UI colour.
    public static let duck: UInt32 = 0xFFDA1A
    public static let duckWing: UInt32 = 0xFFC812
    public static let beak: UInt32 = 0xFF972E
    public static let duckOutline: UInt32 = 0x18191B
    public static let duckText: UInt32 = 0x8A5A00

    public enum Dark {
        // Mac neutrals are a warm scale in both themes (the iPhone app keeps its own tokens); text levels measured in §3.4.
        public static let bg: UInt32 = 0x141110
        public static let sidebar: UInt32 = 0x211E1C
        public static let surface: UInt32 = 0x211E1C
        public static let surfaceRaised: UInt32 = 0x2C2826
        public static let selected: UInt32 = 0x2C2826
        public static let selectedStrong: UInt32 = 0x37322F
        public static let ink: UInt32 = 0xEAE8E6
        public static let muted: UInt32 = 0xA5A09C
        public static let subtle: UInt32 = 0x766F6B
        /// `negative` (was `needs-you`): failure, the Stop button, a destructive Deny, a diff removal.
        public static let negative: UInt32 = 0xF87272
        /// `warning` (§3.1 exception): a thin glyph stroke and a card edge only, never a fill, text or badge.
        public static let warning: UInt32 = 0xE0A030
        /// `working` (§3.3, 2026-11-12): ocean blue, water = an agent at work. 4.56:1 on the dark grounds.
        public static let working: UInt32 = 0x4C8DFF
        /// `done`: the unread dot, the duck's yellow, used only for unread.
        public static let done: UInt32 = 0xFFDA1A
        /// `success`: a diff addition, a check, an "on" switch. Green never marks a chat's state.
        public static let success: UInt32 = 0x4ADE80
        /// `info`: links and neutral confirmation (was `done`'s blue).
        public static let info: UInt32 = 0x38BDF8
        public static let idle: UInt32 = 0x71717A
        public static let offline: UInt32 = 0x52525B
    }

    public enum Light {
        public static let bg: UInt32 = 0xFFFFFF
        public static let sidebar: UInt32 = 0xFAFAF9
        public static let surface: UInt32 = 0xFAFAF9
        public static let surfaceRaised: UInt32 = 0xFFFFFF
        public static let selected: UInt32 = 0xF0EEED
        public static let selectedStrong: UInt32 = 0xE7E4E2
        public static let ink: UInt32 = 0x2C2826
        public static let muted: UInt32 = 0x8E8885
        public static let subtle: UInt32 = 0xA5A09C
        public static let negative: UInt32 = 0xDC2828
        public static let warning: UInt32 = 0xA16207
        public static let working: UInt32 = 0x1D4ED8
        /// Unread on light: `duck-text`, because the duck's own yellow is 1.37:1 on white.
        public static let done: UInt32 = 0x8A5A00
        public static let success: UInt32 = 0x16A249
        public static let info: UInt32 = 0x0369A1
        public static let idle: UInt32 = 0x71717A
        public static let offline: UInt32 = 0xA1A1AA
    }

    /// DESIGN.md §8.10 and §11: the Mac workbench's fixed measures, in points.
    public enum Workbench {
        public static let sidebarWidth: Double = 256
        public static let inspectorWidth: Double = 340
        public static let columnMax: Double = 880
        /// The transcript and composer column in a workspace chat, and the least room kept on each side of it.
        public static let readingColumnMax: Double = 760
        public static let readingInsetMin: Double = 32
        /// The transcript's text sits this far inside the composer's edges (so its column is 760 − 2×20 = 720), like Conductor.
        public static let transcriptTextInset: Double = 20
        /// Agent text extra leading (line height ≈ 1.55 × size: 14 × 1.55 = 21.7 with SF's 16.8 natural line).
        public static let readingLeading: Double = 4.9
        /// Reading rhythm in em of the body size: paragraph gap, gap around a list and above/below a heading; list items 6 pt apart, 1.65 em indent.
        public static let paragraphGapEm: Double = 1.15
        public static let listGapEm: Double = 1.0
        public static let headingAboveEm: Double = 1.6
        public static let headingBelowEm: Double = 0.7
        public static let listItemGap: Double = 6
        public static let listIndentEm: Double = 1.65
        /// Soft fade where the transcript meets the dock; the transcript's bottom padding is at least this.
        public static let dockFadeHeight: Double = 48
        public static let chatRowHeight: Double = 28
        /// `reading`: agent text in the transcript, size and line height.
        public static let readingSize: Double = 14
        public static let readingLine: Double = 23
        /// The person's message bubble: radius 16 with the corner on the speaker's side (bottom trailing) tightened to 6, at most 80% of the column.
        public static let userBubbleRadius: Double = 16
        public static let userBubbleTightRadius: Double = 6
        public static let userBubbleMaxFraction: Double = 0.8
        /// The terminal panel's text, JetBrains Mono at 12pt, and its tab strip.
        public static let terminalFontSize: Double = 12
        public static let terminalTabHeight: Double = 32
    }

    /// DESIGN.md §8.10 and §11: the terminal panel's palette, in the brand's warm neutrals. `ansi` is the sixteen
    /// colours in order (black, red, green, yellow, blue, magenta, cyan, white, then the bright eight). Ground is
    /// the centre's `bg`; every colour but the two blacks is at least 4.5:1 on it (a test pins that).
    public struct TerminalPalette: Sendable {
        public let background: UInt32
        public let foreground: UInt32
        public let cursor: UInt32
        public let selection: UInt32
        public let ansi: [UInt32]
    }

    public enum Terminal {
        public static let dark = TerminalPalette(
            background: Dark.bg, foreground: 0xE7E2DD, cursor: 0xE7E2DD, selection: 0x4A4643,
            ansi: [
                0x3A3735, 0xF87171, 0x4ADE80, 0xE0B84A, 0x6FA8F5, 0xD08AF0, 0x4FCFE0, 0xC9C3BD,
                0x8A8480, 0xFCA5A5, 0x86EFAC, 0xF2D27A, 0x9CC4FA, 0xE3B0F7, 0x8BE3EE, 0xF4F4F5,
            ])
        public static let light = TerminalPalette(
            background: Light.bg, foreground: 0x2A2623, cursor: 0x2A2623, selection: 0xD8D3CE,
            ansi: [
                0xD8D3CE, 0xB91C1C, 0x15803D, 0x8A5A00, 0x1D4ED8, 0x9333EA, 0x0E7490, 0x52525B,
                0x6B6560, 0xA81818, 0x166534, 0x7A4F00, 0x1E40AF, 0x7E22CE, 0x155E75, 0x18181B,
            ])
    }
}
