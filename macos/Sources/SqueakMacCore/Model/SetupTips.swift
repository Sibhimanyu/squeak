import Foundation

/// Where a tip leads: the permission explainer, or a Settings page.
public enum TipDestination: Sendable, Equatable {
    case permission(PermissionKind)
    case settings(SettingsSection)
}

/// One suggestion shown in the menu-bar panel after setup. Each says what it gives, in one calm sentence.
public enum Tip: String, CaseIterable, Sendable, Codable {
    // Declaration order is the order they are offered in when several are due.
    case replyIntoConductor, answerTerminalAgents, keepAwake, phoneCalls, notificationRules, quickShortcut

    public var title: String {
        switch self {
        case .keepAwake: "Keep this Mac awake"
        case .replyIntoConductor: "Reply into Conductor's window"
        case .answerTerminalAgents: "Answer Terminal agents"
        case .quickShortcut: "Quick-message shortcut"
        case .phoneCalls: "Phone calls and PIN"
        case .notificationRules: "Fewer notifications?"
        }
    }

    public var detail: String {
        switch self {
        case .keepAwake: "Your phone can only reach this Mac while it is awake. Choose how long to keep it up."
        case .replyIntoConductor: "Allow Squeak Hands, so your replies are typed into Conductor's own window and stream live."
        case .answerTerminalAgents: "Allow Squeak Hands to control Terminal, so you can answer a claude or codex there."
        case .quickShortcut: "Double-tap Control to message an agent from anywhere. It needs Input Monitoring, then a relaunch."
        case .phoneCalls: "An agent has waited a while. Squeak can ring you, and a PIN keeps the call yours."
        case .notificationRules: "Your chat apps got a lot of cards today. Choose what each one may push."
        }
    }

    public var actionTitle: String {
        switch self {
        case .keepAwake: "Set up"
        case .replyIntoConductor, .answerTerminalAgents, .quickShortcut: "Allow"
        case .phoneCalls: "Open phone calls"
        case .notificationRules: "Fewer?"
        }
    }

    public var destination: TipDestination {
        switch self {
        case .keepAwake: .settings(.awake)
        case .replyIntoConductor: .permission(.accessibility)
        case .answerTerminalAgents: .permission(.automation)
        case .quickShortcut: .permission(.inputMonitoring)
        case .phoneCalls: .settings(.voice)
        case .notificationRules: .settings(.notifications)
        }
    }
}

/// What the app reads at this moment; the rules decide nothing else.
public struct TipFacts: Sendable, Equatable {
    /// First run is open, or started and not finished: no tip may show.
    public var firstRunActive: Bool
    /// Ids of what is paired or set up as a way to be reached: each active phone, "telegram", "cliq".
    public var channelIDs: Set<String>
    /// A phone or Telegram is set up (the way a question reaches you away from the Mac).
    public var phoneOrTelegramSetUp: Bool
    /// A keep-awake session is running or its lid rule is installed.
    public var awakeSetUp: Bool
    /// nil when unknown (Squeak Hands cannot be read).
    public var accessibilityGranted: Bool?
    public var automationGranted: Bool?
    public var inputMonitoringGranted: Bool
    public var voiceSetUp: Bool
    /// How long the longest-waiting question has gone unanswered.
    public var longestQuestionWait: TimeInterval?
    public var cardsPushedToday: Int

    public init(firstRunActive: Bool = false, channelIDs: Set<String> = [], phoneOrTelegramSetUp: Bool = false,
                awakeSetUp: Bool = false, accessibilityGranted: Bool? = nil, automationGranted: Bool? = nil,
                inputMonitoringGranted: Bool = false, voiceSetUp: Bool = false, longestQuestionWait: TimeInterval? = nil,
                cardsPushedToday: Int = 0) {
        self.firstRunActive = firstRunActive; self.channelIDs = channelIDs; self.phoneOrTelegramSetUp = phoneOrTelegramSetUp
        self.awakeSetUp = awakeSetUp; self.accessibilityGranted = accessibilityGranted; self.automationGranted = automationGranted
        self.inputMonitoringGranted = inputMonitoringGranted; self.voiceSetUp = voiceSetUp
        self.longestQuestionWait = longestQuestionWait; self.cardsPushedToday = cardsPushedToday
    }
}

/// Tips seen, hidden and earned, saved between launches. Every rule that needs the past lives here.
public struct TipHistory: Sendable, Equatable, Codable {
    public static let notNowDays = 14
    public static let keepAwakeWindowDays = 3
    public static let composerUsesForShortcut = 3
    public static let questionWaitForCalls: TimeInterval = 15 * 60
    public static let cardsInADay = 25

    public var hiddenUntil: [String: Date] = [:]
    public var neverAgain: Set<String> = []
    /// The tip on screen until it is dismissed, opened or no longer true.
    public var current: Tip?
    public var lastStartedAt: Date?
    public var composerUses = 0
    /// What was set up when last looked, to notice a new pairing. nil before the first look.
    public var knownChannels: [String]?
    public var pairedAt: Date?
    /// The first reply that went through the background because Hands lacked Accessibility.
    public var accessibilityFallbackAt: Date?
    /// The first reply to a Terminal agent that failed for Automation.
    public var terminalAutomationFailedAt: Date?

    public init() {}

    private enum Keys: String, CodingKey {
        case hiddenUntil, neverAgain, current, lastStartedAt, composerUses, knownChannels, pairedAt
        case accessibilityFallbackAt, terminalAutomationFailedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        hiddenUntil = (try? c.decode([String: Date].self, forKey: .hiddenUntil)) ?? [:]
        neverAgain = (try? c.decode(Set<String>.self, forKey: .neverAgain)) ?? []
        current = (try? c.decode(String.self, forKey: .current)).flatMap(Tip.init(rawValue:))
        lastStartedAt = try? c.decode(Date.self, forKey: .lastStartedAt)
        composerUses = (try? c.decode(Int.self, forKey: .composerUses)) ?? 0
        knownChannels = try? c.decode([String].self, forKey: .knownChannels)
        pairedAt = try? c.decode(Date.self, forKey: .pairedAt)
        accessibilityFallbackAt = try? c.decode(Date.self, forKey: .accessibilityFallbackAt)
        terminalAutomationFailedAt = try? c.decode(Date.self, forKey: .terminalAutomationFailedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(hiddenUntil, forKey: .hiddenUntil)
        try c.encode(neverAgain, forKey: .neverAgain)
        try c.encodeIfPresent(current?.rawValue, forKey: .current)
        try c.encodeIfPresent(lastStartedAt, forKey: .lastStartedAt)
        try c.encode(composerUses, forKey: .composerUses)
        try c.encodeIfPresent(knownChannels, forKey: .knownChannels)
        try c.encodeIfPresent(pairedAt, forKey: .pairedAt)
        try c.encodeIfPresent(accessibilityFallbackAt, forKey: .accessibilityFallbackAt)
        try c.encodeIfPresent(terminalAutomationFailedAt, forKey: .terminalAutomationFailedAt)
    }

    // MARK: Events

    /// Looks at what is set up. Something new since the last look is a pairing that just completed.
    public mutating func observeChannels(_ ids: Set<String>, now: Date) {
        if let known = knownChannels, !ids.isSubset(of: Set(known)) { pairedAt = now }
        knownChannels = ids.sorted()
    }

    public mutating func noteComposerUse() { composerUses += 1 }

    /// A reply went through the background because Squeak Hands has no Accessibility. Only the first counts.
    public mutating func noteBackgroundFallbackForAccessibility(at now: Date) {
        if accessibilityFallbackAt == nil { accessibilityFallbackAt = now }
    }

    /// A reply to a Terminal agent failed for Automation. Only the first counts.
    public mutating func noteTerminalAutomationFailure(at now: Date) {
        if terminalAutomationFailedAt == nil { terminalAutomationFailedAt = now }
    }

    /// "Not now" hides a tip for 14 days; "Don't show again" for good.
    public mutating func dismiss(_ tip: Tip, forever: Bool, now: Date, calendar: Calendar = .current) {
        if forever {
            neverAgain.insert(tip.rawValue)
        } else {
            hiddenUntil[tip.rawValue] = calendar.date(byAdding: .day, value: Self.notNowDays, to: now)
        }
        if current == tip { current = nil }
    }

    /// The person followed the tip: it counts as seen, so it rests for 14 days unless what it asks for comes true.
    public mutating func opened(_ tip: Tip, now: Date, calendar: Calendar = .current) {
        dismiss(tip, forever: false, now: now, calendar: calendar)
    }

    // MARK: Rules

    /// Whether what the tip is about is true now, ignoring dismissals and the one-a-day pace.
    public func isDue(_ tip: Tip, facts: TipFacts, now: Date, calendar: Calendar = .current) -> Bool {
        switch tip {
        case .keepAwake:
            guard let pairedAt, !facts.awakeSetUp else { return false }
            let limit = calendar.date(byAdding: .day, value: Self.keepAwakeWindowDays, to: pairedAt) ?? pairedAt
            return now < limit
        case .replyIntoConductor:
            return accessibilityFallbackAt != nil && facts.accessibilityGranted != true
        case .answerTerminalAgents:
            return terminalAutomationFailedAt != nil && facts.automationGranted != true
        case .quickShortcut:
            return composerUses >= Self.composerUsesForShortcut && !facts.inputMonitoringGranted
        case .phoneCalls:
            return facts.phoneOrTelegramSetUp && !facts.voiceSetUp
                && (facts.longestQuestionWait ?? 0) >= Self.questionWaitForCalls
        case .notificationRules:
            return facts.cardsPushedToday > Self.cardsInADay
        }
    }

    private func allowed(_ tip: Tip, facts: TipFacts, now: Date, calendar: Calendar) -> Bool {
        guard !neverAgain.contains(tip.rawValue) else { return false }
        if let until = hiddenUntil[tip.rawValue], until > now { return false }
        return isDue(tip, facts: facts, now: now, calendar: calendar)
    }

    /// The one tip to show, or nil. Never during first run; one at a time (the tip on screen stays until it
    /// is dismissed, opened or no longer true); a new one starts at most once a calendar day.
    public mutating func tipToShow(facts: TipFacts, now: Date, calendar: Calendar = .current) -> Tip? {
        guard !facts.firstRunActive else { return nil }
        if let current, allowed(current, facts: facts, now: now, calendar: calendar) { return current }
        current = nil
        if let last = lastStartedAt, calendar.isDate(last, inSameDayAs: now) { return nil }
        guard let next = Tip.allCases.first(where: { allowed($0, facts: facts, now: now, calendar: calendar) }) else { return nil }
        current = next
        lastStartedAt = now
        return next
    }
}

/// How long each question has waited, from the moments the app first saw it waiting.
public struct QuestionWaitTracker: Sendable, Equatable {
    private var since: [String: Date] = [:]

    public init() {}

    /// `waiting` is the keys of the sessions asking a question now; the others are forgotten.
    public mutating func observe(waiting: Set<String>, now: Date) {
        since = since.filter { waiting.contains($0.key) }
        for key in waiting where since[key] == nil { since[key] = now }
    }

    public func longest(now: Date) -> TimeInterval? {
        since.values.map { now.timeIntervalSince($0) }.max()
    }
}

/// What a reply's result says about a missing grant. Read from the daemon's own fixed sentences
/// (`describeUiFailure`, `describeScreenError` in `src/fleet`).
public enum ReplyGrantSignal: Sendable, Equatable {
    case accessibility
    case terminalAutomation

    /// `via` and `fallbackReason` of an accepted reply, or the `reason` of a refused one.
    public static func read(via: String?, fallbackReason: String?, refusedReason: String?) -> ReplyGrantSignal? {
        if via == "background", fallbackReason?.contains("Accessibility") == true { return .accessibility }
        if let refusedReason, refusedReason.contains("Automation"), refusedReason.contains("Terminal") { return .terminalAutomation }
        return nil
    }
}
