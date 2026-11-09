/// DESIGN.md §11, as hex values (RGB). The app's `Theme` builds its colours from these, and a test
/// pins them, so a change to the design tokens has to change both on purpose.
public enum Tokens {
    // Brand (§3.1). `duck` is a fill, never text on a light ground; `beak` is never a UI colour.
    public static let duck: UInt32 = 0xFFDA1A
    public static let duckWing: UInt32 = 0xFFC812
    public static let beak: UInt32 = 0xFF972E
    public static let duckOutline: UInt32 = 0x18191B
    public static let duckText: UInt32 = 0x8A5A00

    public enum Dark {
        // Mac dark neutrals follow Conductor's warm greys (the iPhone app keeps its own tokens).
        public static let bg: UInt32 = 0x1A1514
        public static let sidebar: UInt32 = 0x24211E
        public static let surface: UInt32 = 0x24211E
        public static let surfaceRaised: UInt32 = 0x2B2825
        public static let selected: UInt32 = 0x34312F
        public static let selectedStrong: UInt32 = 0x3A3735
        public static let ink: UInt32 = 0xF4F4F5
        public static let muted: UInt32 = 0xA1A1AA
        public static let subtle: UInt32 = 0x71717A
        /// `negative` (was `needs-you`): failure, the Stop button, a destructive Deny, a diff removal.
        public static let negative: UInt32 = 0xF87171
        /// `warning` (§3.1 exception): a thin glyph stroke and a card edge only, never a fill, text or badge.
        public static let warning: UInt32 = 0xE0A030
        public static let working: UInt32 = 0x22C55E
        public static let done: UInt32 = 0x38BDF8
        public static let idle: UInt32 = 0x71717A
        public static let offline: UInt32 = 0x52525B
    }

    public enum Light {
        public static let bg: UInt32 = 0xF4F4F5
        public static let sidebar: UInt32 = 0xEBEBEC
        public static let surface: UInt32 = 0xFFFFFF
        public static let surfaceRaised: UInt32 = 0xFFFFFF
        public static let selected: UInt32 = 0xE0E0E2
        public static let selectedStrong: UInt32 = 0xD4D4D8
        public static let ink: UInt32 = 0x18181B
        public static let muted: UInt32 = 0x52525B
        public static let subtle: UInt32 = 0x71717A
        public static let negative: UInt32 = 0xDC2626
        public static let warning: UInt32 = 0xA16207
        public static let working: UInt32 = 0x15803D
        public static let done: UInt32 = 0x0369A1
        public static let idle: UInt32 = 0x71717A
        public static let offline: UInt32 = 0xA1A1AA
    }

    /// DESIGN.md §8.10 and §11: the Mac workbench's fixed measures, in points.
    public enum Workbench {
        public static let sidebarWidth: Double = 248
        public static let inspectorWidth: Double = 320
        public static let columnMax: Double = 880
        public static let chatRowHeight: Double = 28
        /// `reading`: agent text in the transcript, size and line height.
        public static let readingSize: Double = 14
        public static let readingLine: Double = 22
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
            background: Light.bg, foreground: 0x2A2623, cursor: 0x2A2623, selection: 0xD4D4D8,
            ansi: [
                0xD4D4D8, 0xB91C1C, 0x15803D, 0x8A5A00, 0x1D4ED8, 0x9333EA, 0x0E7490, 0x52525B,
                0x6B6560, 0xA81818, 0x166534, 0x7A4F00, 0x1E40AF, 0x7E22CE, 0x155E75, 0x18181B,
            ])
    }
}
