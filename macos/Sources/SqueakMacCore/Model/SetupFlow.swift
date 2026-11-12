import Foundation

/// What is installed on this Mac, found quietly when setup opens. Pure over its inputs so tests need no real home.
public struct AgentDetection: Sendable, Equatable {
    public var claudeCode: Bool
    public var codex: Bool
    /// Read for Settings › Conductor only; first run neither needs nor offers it.
    public var conductor: Bool

    public init(claudeCode: Bool = false, codex: Bool = false, conductor: Bool = false) {
        self.claudeCode = claudeCode; self.codex = codex; self.conductor = conductor
    }

    public var anyAgent: Bool { claudeCode || codex }

    public static func detect(home: String, pathDirs: [String], exists: (String) -> Bool) -> AgentDetection {
        func onPath(_ tool: String) -> Bool { pathDirs.contains { exists(($0 as NSString).appendingPathComponent(tool)) } }
        return AgentDetection(
            claudeCode: exists(home + "/.claude") || onPath("claude") || exists(home + "/.local/bin/claude"),
            codex: exists(home + "/.codex") || onPath("codex"),
            conductor: exists("/Applications/Conductor.app") || exists(home + "/Applications/Conductor.app"))
    }
}

/// The six steps of first run, in the order the person meets them. Welcome and Done are the frame; Start Squeak
/// and Your agents are required; Account and Your phone can be skipped.
public enum SetupStage: String, CaseIterable, Sendable, Identifiable {
    case welcome, service, agents, account, phone, done
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .welcome: "Welcome"
        case .service: "Start Squeak"
        case .agents: "Your agents"
        case .account: "Account"
        case .phone: "Your phone"
        case .done: "Done"
        }
    }

    /// Settings › Setup lists these; Welcome and Done are only the frame.
    public static let listed: [SetupStage] = [.service, .agents, .account, .phone]

    /// Nothing works without these two.
    public var isRequired: Bool { self == .service || self == .agents }

    public var canSkip: Bool { self == .account || self == .phone }
}

public enum SetupStageState: Sendable, Equatable { case done, skipped, todo }

/// What the flow remembers between launches.
public struct SetupProgress: Sendable, Equatable {
    public var skipped: Set<String>
    /// Stages seen finished once, so a later change in the facts (the session ended) never reopens them.
    public var completed: Set<String>
    /// "Get started" was pressed.
    public var started: Bool
    /// Done was reached, or the person had everything already.
    public var finished: Bool

    public init(skipped: Set<String> = [], completed: Set<String> = [], started: Bool = false, finished: Bool = false) {
        self.skipped = skipped; self.completed = completed; self.started = started; self.finished = finished
    }

    /// Old builds stored other step names under the same key (`connect`, `firstWin`, `away`); only this flow's
    /// stages count, so an old half-finished run resumes from the facts.
    public static func clean(_ raw: Set<String>) -> Set<String> {
        raw.intersection(SetupStage.allCases.map(\.rawValue))
    }
}

public enum ConnectAction: Sendable, Equatable { case service, hooks }

public enum ConnectRowState: Sendable, Equatable {
    case pending, working, done
    /// Stopped, with what to do about it.
    case failed(String)

    public var isFailed: Bool { if case .failed = self { true } else { false } }
}

public struct ConnectRow: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    /// "Claude Code ✓  Codex ✓" on the hooks row; nil elsewhere.
    public var detail: String?
    public var state: ConnectRowState
}

/// Everything the flow reads, gathered by the app. The flow decides nothing else.
public struct SetupFlowFacts: Sendable, Equatable {
    public var setup: SetupFacts
    public var detection: AgentDetection
    public var hasActiveSession: Bool
    /// This Mac is signed in to a Squeak account.
    public var signedIn: Bool
    /// An iPhone or browser is paired (or signed in) and approved.
    public var phonePaired: Bool
    /// An action (service repair, hooks install) is running right now.
    public var connectBusy: Bool

    public init(setup: SetupFacts = SetupFacts(), detection: AgentDetection = AgentDetection(), hasActiveSession: Bool = false,
                signedIn: Bool = false, phonePaired: Bool = false, connectBusy: Bool = false) {
        self.setup = setup; self.detection = detection; self.hasActiveSession = hasActiveSession
        self.signedIn = signedIn; self.phonePaired = phonePaired; self.connectBusy = connectBusy
    }
}

/// First run's order, detection, states, resume and what counts as done. It runs nothing: each screen calls
/// the app's existing actions (daemon repair, hooks install, the account and channel models).
public struct SetupFlow: Sendable, Equatable {
    public let facts: SetupFlowFacts
    public let progress: SetupProgress

    public init(_ facts: SetupFlowFacts, progress: SetupProgress = SetupProgress()) {
        self.facts = facts; self.progress = progress
    }

    public var stages: [SetupStage] { SetupStage.allCases }

    // MARK: Service and agents

    private var hooksInstalled: Bool { facts.setup.hooks?.state == .installed }
    public var serviceRunning: Bool { facts.setup.service == .running }
    /// macOS has Squeak's background item switched off: the step asks for it before anything starts.
    public var serviceNeedsApproval: Bool { facts.setup.service == .needsApproval }

    /// The person already has a working Squeak: the service answers and the hooks are in.
    public var isReturning: Bool { serviceRunning && hooksInstalled }

    /// The service runs and the hooks are in for every agent found (or none was found, which only explains).
    public var connectReady: Bool { serviceRunning && (hooksInstalled || agentsFound.isEmpty) }

    /// The agents to name: those found here, else those the daemon's reading found.
    public var agentsFound: [String] {
        var out: [String] = []
        let h = facts.setup.hooks
        if facts.detection.claudeCode || h?.claude.settingsFound == true { out.append("Claude Code") }
        if facts.detection.codex || h?.codex.agentsFound == true { out.append("Codex") }
        return out
    }

    public func isHooked(_ name: String) -> Bool {
        guard let h = facts.setup.hooks else { return false }
        if h.state == .installed { return true }
        return name == "Claude Code" ? h.claude.hooksInstalled : h.codex.askFormat
    }

    public var serviceRow: ConnectRow {
        let state: ConnectRowState
        switch facts.setup.service {
        case .running: state = .done
        case .failed(let why): state = .failed(why.isEmpty ? "The service didn't start. Try again." : why)
        case .unavailable: state = .failed("This build carries no background service. Start one with squeak start.")
        case .installing: state = .working
        case .needsApproval: state = .pending
        case .checking, .notInstalled: state = facts.connectBusy ? .working : .pending
        }
        return ConnectRow(id: "service", title: "Background service", detail: nil, state: state)
    }

    public var hooksRow: ConnectRow {
        let s = facts.setup
        let names = agentsFound
        if names.isEmpty {
            return ConnectRow(id: "hooks", title: "Claude Code or Codex", detail: nil,
                              state: .failed("No agent found. Install Claude Code or Codex, then check again."))
        }
        let state: ConnectRowState
        if hooksInstalled { state = .done }
        else if s.hooksNeedUpdate { state = .failed(ServiceSentence.updateService) }
        else if let p = s.hooksProblem, !p.isEmpty { state = .failed(p) }
        else if s.hooks?.state == .error || s.hooks?.state == .unknown {
            let m = s.hooks?.message ?? ""
            state = .failed(m.isEmpty ? "Squeak couldn't read the agent settings. Try again." : m)
        }
        else if facts.connectBusy && serviceRunning { state = .working }
        else { state = .pending }
        let detail = names.map { "\($0) \(isHooked($0) ? "✓" : "…")" }.joined(separator: "  ")
        return ConnectRow(id: "hooks", title: "Agent hooks", detail: detail, state: state)
    }

    public var connectRows: [ConnectRow] { [serviceRow, hooksRow] }

    /// What to run next. Each action runs once per press (`attempted`); a failure stops the run and waits for the person.
    public func nextConnectAction(attempted: Set<ConnectAction>) -> ConnectAction? {
        let s = facts.setup
        if facts.connectBusy { return nil }
        if !serviceRunning {
            if case .installing = s.service { return nil }
            if s.service == .needsApproval { return nil }
            return attempted.contains(.service) ? nil : .service
        }
        if !agentsFound.isEmpty, !hooksInstalled {
            if s.hooksNeedUpdate || attempted.contains(.hooks) { return nil }
            return .hooks
        }
        return nil
    }

    // MARK: Stages

    private func factsDone(_ s: SetupStage) -> Bool {
        switch s {
        case .welcome: progress.started || isReturning
        case .service: serviceRunning
        case .agents: serviceRunning && hooksInstalled
        case .account: facts.signedIn
        case .phone: facts.phonePaired
        case .done: progress.finished
        }
    }

    public func isDone(_ s: SetupStage) -> Bool { factsDone(s) || progress.completed.contains(s.rawValue) }

    public func state(_ s: SetupStage) -> SetupStageState {
        if isDone(s) { return .done }
        if s.canSkip, progress.skipped.contains(s.rawValue) { return .skipped }
        return .todo
    }

    /// Where a first run or a resume starts: the first screen neither done nor skipped. Someone who already has
    /// a working Squeak, or who finished once, goes straight to Done.
    public var startStage: SetupStage {
        if progress.finished || isReturning { return .done }
        return stages.first { $0 != .done && state($0) == .todo } ?? .done
    }

    public func next(after s: SetupStage) -> SetupStage? {
        guard let i = stages.firstIndex(of: s), i + 1 < stages.count else { return nil }
        return stages[i + 1]
    }

    /// Every screen has a Back except Welcome (nothing before it).
    public func previous(before s: SetupStage) -> SetupStage? {
        guard let i = stages.firstIndex(of: s), i > 0 else { return nil }
        return stages[i - 1]
    }

    /// A required step moves on only once it worked; Your agents also lets someone with no agent installed
    /// go on, since it only explains then.
    public func canContinue(_ s: SetupStage) -> Bool {
        switch s {
        case .service: serviceRunning
        case .agents: connectReady
        default: true
        }
    }

    /// Whether Esc may leave the window: never in the middle of a required step.
    public func canDismiss(_ s: SetupStage) -> Bool { !(s.isRequired && !canContinue(s)) }

    /// What the Settings sidebar's "Finish setting up" card (`SetupCard`) offers: neither done nor skipped-and-left.
    public var openStages: [SetupStage] { SetupStage.listed.filter { state($0) != .done } }

    // MARK: Persistence helpers

    public static func skipping(_ s: SetupStage, in set: Set<String>) -> Set<String> {
        s.canSkip ? set.union([s.rawValue]) : set
    }

    public static func unskipping(_ s: SetupStage, in set: Set<String>) -> Set<String> { set.subtracting([s.rawValue]) }

    /// Stages the facts show finished right now and `progress` does not yet remember.
    public var newlyCompleted: Set<String> {
        Set(SetupStage.listed.filter(factsDone).map(\.rawValue)).subtracting(progress.completed)
    }
}

/// The web app's pairing link: the daemon's `squeak://pair?d=<payload>` with the same payload behind `#pair=`.
public enum WebPairLink {
    /// Where Squeak for Web lives when no relay address is known: the current Catalyst app URL.
    public static let fallbackBase = "https://squeak-60083782173.development.catalystserverless.in/app/index.html"

    /// The page the link opens: the hosted relay's own `<origin>/app/index.html` (from the daemon's `signInUrl`), else the fallback.
    public static func base(signInUrl: String?) -> String {
        guard let signInUrl, let c = URLComponents(string: signInUrl), c.scheme == "https", let host = c.host, !host.isEmpty else { return fallbackBase }
        return "https://\(host)\(c.port.map { ":\($0)" } ?? "")/app/index.html"
    }

    /// The address without the scheme, for "open … and paste the link".
    public static func address(signInUrl: String?) -> String {
        base(signInUrl: signInUrl).replacingOccurrences(of: "https://", with: "")
    }

    /// `d`'s value exactly as the daemon wrote it (never decoded and re-encoded). Nil for any other URL.
    public static func payload(fromPairingURL url: String) -> String? {
        let prefix = "squeak://pair?"
        guard url.hasPrefix(prefix) else { return nil }
        for part in url.dropFirst(prefix.count).split(separator: "&", omittingEmptySubsequences: true) where part.hasPrefix("d=") {
            let v = String(part.dropFirst(2))
            return v.isEmpty ? nil : v
        }
        return nil
    }

    public static func url(fromPairingURL url: String, signInUrl: String? = nil) -> String? {
        payload(fromPairingURL: url).map { base(signInUrl: signInUrl) + "#pair=" + $0 }
    }
}

/// The Telegram guide's five steps; `current` is the one to act on, from what is already true.
public enum TelegramStep: Int, CaseIterable, Sendable {
    case openBotFather, createBot, copyToken, sendMessage, test

    public var title: String {
        switch self {
        case .openBotFather: "Open BotFather"
        case .createBot: "Send /newbot and pick a name"
        case .copyToken: "Copy the token it gives you"
        case .sendMessage: "Send your new bot any message"
        case .test: "Save and send a test card"
        }
    }

    public static func current(botFatherOpened: Bool, tokenReady: Bool, chatLinked: Bool) -> TelegramStep {
        if chatLinked { return .test }
        if tokenReady { return .sendMessage }
        return botFatherOpened ? .copyToken : .openBotFather
    }
}
