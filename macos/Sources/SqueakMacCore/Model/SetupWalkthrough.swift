import Foundation

/// One screen of the guided setup, in the order the person meets them.
public enum WalkStep: String, CaseIterable, Sendable, Identifiable {
    case service, hooks, conductor, hands, notifications, hotkey, iphone, telegram, cliq, voice, awake
    public var id: String { rawValue }

    /// Squeak cannot work without these two, so they have no Skip.
    public var isRequired: Bool { self == .service || self == .hooks }

    public var title: String {
        switch self {
        case .service: "Background service"
        case .hooks: "Agent hooks"
        case .conductor: "Conductor"
        case .hands: "Reply into Conductor's window"
        case .notifications: "Notifications"
        case .hotkey: "Quick-message shortcut"
        case .iphone: "iPhone"
        case .telegram: "Telegram"
        case .cliq: "Zoho Cliq"
        case .voice: "Phone calls"
        case .awake: "Keep awake"
        }
    }

    /// One sentence on why the step matters.
    public var why: String {
        switch self {
        case .service: "Watches every agent session and answers for you."
        case .hooks: "Lets Claude Code and Codex tell Squeak when they need you."
        case .conductor: "Lets Squeak start Conductor chats and answer them live."
        case .hands: "When Conductor's link is down, Squeak Hands types the reply for you and needs Accessibility."
        case .notifications: "A banner when a session needs you, and a choice of what each channel may push."
        case .hotkey: "Double-tap Control to message an agent from anywhere."
        case .iphone: "Follow sessions and answer from your iPhone."
        case .telegram: "Get the same cards in a private Telegram chat and answer there."
        case .cliq: "Get cards in Zoho Cliq and reply from your team chat."
        case .voice: "Ring your phone when an agent is waiting on you, with a PIN so only you can answer."
        case .awake: "Keep this Mac reachable while you are away, lid open or closed."
        }
    }
}

public enum WalkState: Sendable, Equatable {
    case done, skipped, todo
}

/// What the walk-through reads besides the checklist's own facts: whether each channel is already set up.
public struct WalkFacts: Sendable, Equatable {
    public var setup: SetupFacts
    public var iphone: Bool
    public var telegram: Bool
    public var cliq: Bool
    public var voice: Bool
    public var awake: Bool

    public init(setup: SetupFacts = SetupFacts(), iphone: Bool = false, telegram: Bool = false, cliq: Bool = false,
                voice: Bool = false, awake: Bool = false) {
        self.setup = setup; self.iphone = iphone; self.telegram = telegram; self.cliq = cliq
        self.voice = voice; self.awake = awake
    }
}

/// The guided setup's order, which steps are done from the existing facts, skip and resume. It decides nothing
/// about how a step is done: every screen reuses the settings view or checklist action for that.
public struct SetupWalkthrough: Sendable, Equatable {
    public let checklist: SetupChecklist
    public let facts: WalkFacts
    public let skipped: Set<String>

    public init(_ facts: WalkFacts, skipped: Set<String> = []) {
        self.facts = facts
        self.checklist = SetupChecklist(facts.setup)
        self.skipped = skipped
    }

    public var steps: [WalkStep] { WalkStep.allCases }
    public var total: Int { steps.count }

    public func isDone(_ s: WalkStep) -> Bool {
        let f = facts.setup
        switch s {
        case .service: return checklist.step(.service).state == .done
        case .hooks: return checklist.step(.hooks).state == .done
        case .conductor:
            // Not installed: nothing to set up, so the screen passes straight through.
            return checklist.step(.conductor).state == .done || !f.conductorInstalled || f.relay?.state == .notInstalled
        case .hands: return f.relay?.state == .connected
        case .notifications: return checklist.step(.notifications).state == .done
        case .hotkey: return checklist.step(.hotkey).state == .done
        case .iphone: return facts.iphone
        case .telegram: return facts.telegram
        case .cliq: return facts.cliq
        case .voice: return facts.voice
        case .awake: return facts.awake
        }
    }

    public func state(_ s: WalkStep) -> WalkState {
        if isDone(s) { return .done }
        if !s.isRequired, skipped.contains(s.rawValue) { return .skipped }
        return .todo
    }

    public func canSkip(_ s: WalkStep) -> Bool { !s.isRequired }

    /// Continue is open once a required step is done; every other step can always be passed.
    public func canContinue(_ s: WalkStep) -> Bool { !s.isRequired || isDone(s) }

    public func index(_ s: WalkStep) -> Int { steps.firstIndex(of: s) ?? 0 }
    public func progressLabel(_ s: WalkStep) -> String { "\(index(s) + 1) of \(total)" }

    /// Where a first run or a resume starts: the first step neither done nor skipped.
    public var firstOpen: WalkStep? { steps.first { state($0) == .todo } }

    public func next(after s: WalkStep) -> WalkStep? {
        let i = index(s); return i + 1 < steps.count ? steps[i + 1] : nil
    }

    public func previous(before s: WalkStep) -> WalkStep? {
        let i = index(s); return i > 0 ? steps[i - 1] : nil
    }

    /// Finished: both required steps done. Skipped steps never hold it back.
    public var isFinished: Bool { steps.filter(\.isRequired).allSatisfy(isDone) }

    public var doneSteps: [WalkStep] { steps.filter { state($0) == .done } }
    public var skippedSteps: [WalkStep] { steps.filter { state($0) == .skipped } }
    /// Neither done nor skipped (not reached yet).
    public var todoSteps: [WalkStep] { steps.filter { state($0) == .todo } }

    // MARK: Skip set

    public static func skipping(_ s: WalkStep, in set: Set<String>) -> Set<String> {
        s.isRequired ? set : set.union([s.rawValue])
    }

    public static func unskipping(_ s: WalkStep, in set: Set<String>) -> Set<String> {
        set.subtracting([s.rawValue])
    }
}
