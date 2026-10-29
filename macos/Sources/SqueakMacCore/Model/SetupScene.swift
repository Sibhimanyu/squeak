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

/// The live scene beside the duck.
public enum SetupSceneKind: Hashable, Sendable {
    case welcome
    case connect
    /// A mock menu bar with the mark highlighted; `sessionTitle` slides in a row once a session is seen.
    case menuBar(sessionTitle: String?)
    case awayChoose
    case iphone
    case web
    case telegram
    case done
}

public enum AwayKind: String, Sendable, Equatable { case iphone, web, telegram }

/// What the director reads, all of it already known to the app.
public struct SetupSceneInput: Sendable, Equatable {
    public var stage: SetupStage
    public var started = false
    public var connectReady = false
    public var connectFailed = false
    public var connectRunning = false
    public var sessionTitle: String?
    public var notificationsGranted = false
    public var awayChoice: AwayKind?
    /// Waiting for a pairing or for the first Telegram message.
    public var awayWaiting = false
    public var awaySucceeded = false

    public init(stage: SetupStage) { self.stage = stage }
}

public struct SetupScenePlan: Equatable, Sendable {
    public var mood: SetupDuckMood
    public var scene: SetupSceneKind
}

public enum SetupDirector {
    /// Which mood and scene each screen shows, for the state it is in.
    public static func plan(_ i: SetupSceneInput) -> SetupScenePlan {
        switch i.stage {
        case .welcome:
            return .init(mood: i.started ? .idle : .asleep, scene: .welcome)
        case .connect:
            let mood: SetupDuckMood = i.connectFailed && !i.connectReady ? .needsYou : i.connectReady ? .celebrating : .working
            return .init(mood: mood, scene: .connect)
        case .firstWin:
            let seen = i.sessionTitle != nil
            return .init(mood: seen || i.notificationsGranted ? .celebrating : .idle, scene: .menuBar(sessionTitle: i.sessionTitle))
        case .away:
            guard let c = i.awayChoice else { return .init(mood: .idle, scene: .awayChoose) }
            let scene: SetupSceneKind = c == .iphone ? .iphone : c == .web ? .web : .telegram
            let mood: SetupDuckMood = i.awaySucceeded ? .celebrating : i.awayWaiting ? .working : .idle
            return .init(mood: mood, scene: scene)
        case .done:
            return .init(mood: .celebrating, scene: .done)
        }
    }

    /// The Connect rows on show: those finished or running, and the next one waiting. Each appears as the one
    /// before it settles.
    public static func revealedRows(_ rows: [ConnectRow]) -> [ConnectRow] {
        var out: [ConnectRow] = []
        for r in rows {
            out.append(r)
            if r.state != .done { break }
        }
        return out
    }

    /// The top track: how far along the five phases are, 0 at Welcome and 1 at Done.
    public static func trackFill(_ s: SetupStage) -> Double {
        let all = SetupStage.allCases
        guard let i = all.firstIndex(of: s), all.count > 1 else { return 0 }
        return Double(i) / Double(all.count - 1)
    }

    /// Whether a segment of the track is reached (filled) with `current` on screen.
    public static func isReached(_ s: SetupStage, current: SetupStage) -> Bool {
        guard let a = SetupStage.allCases.firstIndex(of: s), let b = SetupStage.allCases.firstIndex(of: current) else { return false }
        return a <= b
    }
}

extension PermissionKind {
    /// The app's name as System Settings lists it, and whether it has the app's own icon or the helper's.
    public var listedAppIsHelper: Bool { appInList == "Squeak Hands" }
}
