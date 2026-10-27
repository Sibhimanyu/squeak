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
        public static let needsYou: UInt32 = 0xF87171
        public static let working: UInt32 = 0x22C55E
        public static let done: UInt32 = 0x38BDF8
        public static let error: UInt32 = 0xA78BFA
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
        public static let needsYou: UInt32 = 0xDC2626
        public static let working: UInt32 = 0x15803D
        public static let done: UInt32 = 0x0369A1
        public static let error: UInt32 = 0x7C3AED
        public static let idle: UInt32 = 0x71717A
        public static let offline: UInt32 = 0xA1A1AA
    }
}
