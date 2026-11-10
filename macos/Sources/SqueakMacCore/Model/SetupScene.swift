import Foundation

/// The duck's moods and what each one does (DESIGN.md §6.3). The art is the brand's mood sprites; none is drawn here.
public enum SetupDuckMood: String, CaseIterable, Sendable {
    case asleep, idle, working, celebrating, needsYou, offline

    /// The file in `brand/mood-sprites/`.
    public var spriteFile: String {
        switch self {
        case .asleep: "duck-asleep.png"
        case .idle: "duck.png"
        case .working: "duck-working.png"
        case .celebrating: "duck-celebrating.png"
        case .needsYou: "duck-needs_you.png"
        case .offline: "duck-offline.png"
        }
    }

    public enum Motion: Sendable, Equatable { case bob, hop, wobble, still }

    public var motion: Motion {
        switch self {
        case .asleep, .idle, .working: .bob
        case .celebrating: .hop
        case .needsYou: .wobble
        case .offline: .still
        }
    }

    /// Seconds per cycle: asleep 5.0, idle 3.4, working 1.1, celebrating 0.55, needs you 0.6.
    public var period: Double {
        switch self {
        case .asleep: 5.0
        case .idle: 3.4
        case .working: 1.1
        case .celebrating: 0.55
        case .needsYou: 0.6
        case .offline: 0
        }
    }
}

/// DESIGN.md §7: quick 120 ms, standard 200 ms, emphasis 320 ms.
public enum SetupMotion {
    public static let quick = 0.12
    public static let standard = 0.20
    public static let emphasis = 0.32
}

extension PermissionKind {
    /// The app's name as System Settings lists it, and whether it has the app's own icon or the helper's.
    public var listedAppIsHelper: Bool { appInList == "Squeak Hands" }
}
