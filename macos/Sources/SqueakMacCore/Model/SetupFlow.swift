import Foundation

/// What is installed on this Mac, found quietly on Welcome. Pure over its inputs so tests need no real home.
public struct AgentDetection: Sendable, Equatable {
    public var claudeCode: Bool
    public var codex: Bool
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

/// The five screens of first run, in the order the person meets them.
public enum SetupStage: String, CaseIterable, Sendable, Identifiable {
    case welcome, connect, firstWin, away, done
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .welcome: "Welcome"
        case .connect: "Connect"
        case .firstWin: "See your agents"
        case .away: "Away from this Mac"
        case .done: "Done"
        }
    }

    /// Settings › Setup lists these; Welcome and Done are only the frame.
    public static let listed: [SetupStage] = [.connect, .firstWin, .away]

    /// Connect cannot be skipped: nothing works without it.
    public var canSkip: Bool { self == .firstWin || self == .away }
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

    /// Old builds stored other step names under the same key; only this flow's stages count.
    public static func clean(_ raw: Set<String>) -> Set<String> {
        raw.intersection(SetupStage.allCases.map(\.rawValue))
    }
}

public enum ConnectAction: Sendable, Equatable { case service, hooks, conductor }

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
    /// A phone, the web app, Telegram, Cliq or phone calls is already set up.
    public var awayConfigured: Bool
    /// An action (service repair, hooks, Conductor's link) is running right now.
    public var connectBusy: Bool

    public init(setup: SetupFacts = SetupFacts(), detection: AgentDetection = AgentDetection(), hasActiveSession: Bool = false,
                awayConfigured: Bool = false, connectBusy: Bool = false) {
        self.setup = setup; self.detection = detection; self.hasActiveSession = hasActiveSession
        self.awayConfigured = awayConfigured; self.connectBusy = connectBusy
    }
}

/// First run's order, detection, states, resume and what counts as done. It runs nothing: each screen calls
/// the app's existing actions (daemon repair, hooks install, Conductor's link, the channel models).
public struct SetupFlow: Sendable, Equatable {
    public let facts: SetupFlowFacts
    public let progress: SetupProgress

    public init(_ facts: SetupFlowFacts, progress: SetupProgress = SetupProgress()) {
        self.facts = facts; self.progress = progress
    }

    public var stages: [SetupStage] { SetupStage.allCases }

    // MARK: Connect

    private var hooksInstalled: Bool { facts.setup.hooks?.state == .installed }
    private var serviceRunning: Bool { facts.setup.service == .running }
    private var conductorNeeded: Bool {
        let s = facts.setup
        if s.conductorSkipped || s.relay?.state == .notInstalled { return false }
        return facts.detection.conductor || s.relay?.conductorInstalled == true
    }
    private var conductorConnected: Bool { facts.setup.relay?.state == .connected }

    /// The person already has a working Squeak: the service answers and the hooks are in.
    public var isReturning: Bool { serviceRunning && hooksInstalled }

    /// The service runs, the hooks are in for every agent found, and Conductor's link is up if there is a Conductor.
    public var connectReady: Bool {
        serviceRunning && (hooksInstalled || agentsFound.isEmpty) && (!conductorNeeded || conductorConnected)
    }

    /// The agents to name on the hooks row: those found here, else those the daemon's reading found.
    public var agentsFound: [String] {
        var out: [String] = []
        let h = facts.setup.hooks
        if facts.detection.claudeCode || h?.claude.settingsFound == true { out.append("Claude Code") }
        if facts.detection.codex || h?.codex.agentsFound == true { out.append("Codex") }
        return out
    }

    private func agentHooked(_ name: String) -> Bool {
        guard let h = facts.setup.hooks else { return false }
        if h.state == .installed { return true }
        return name == "Claude Code" ? h.claude.hooksInstalled : h.codex.askFormat
    }

    public var connectRows: [ConnectRow] {
        let s = facts.setup
        var rows: [ConnectRow] = []

        let service: ConnectRowState
        switch s.service {
        case .running: service = .done
        case .failed(let why): service = .failed(why.isEmpty ? "The service didn't start. Try again." : why)
        case .unavailable: service = .failed("This build carries no background service. Start one with squeak start.")
        case .installing: service = .working
        case .checking, .notInstalled: service = facts.connectBusy ? .working : .pending
        }
        rows.append(ConnectRow(id: "service", title: "Background service", detail: nil, state: service))

        let names = agentsFound
        if names.isEmpty {
            rows.append(ConnectRow(id: "hooks", title: "Claude Code or Codex", detail: nil,
                                   state: .failed("No agent found. Install Claude Code or Codex, then check again.")))
        } else {
            let hooks: ConnectRowState
            if hooksInstalled { hooks = .done }
            else if s.hooksNeedUpdate { hooks = .failed(RelayStatus.updateServiceSentence) }
            else if let p = s.hooksProblem, !p.isEmpty { hooks = .failed(p) }
            else if s.hooks?.state == .error || s.hooks?.state == .unknown {
                let m = s.hooks?.message ?? ""
                hooks = .failed(m.isEmpty ? "Squeak couldn't read the agent settings. Try again." : m)
            }
            else if facts.connectBusy && serviceRunning { hooks = .working }
            else { hooks = .pending }
            let detail = names.map { "\($0) \(agentHooked($0) ? "✓" : "…")" }.joined(separator: "  ")
            rows.append(ConnectRow(id: "hooks", title: "Agent hooks", detail: detail, state: hooks))
        }

        if conductorNeeded {
            let c: ConnectRowState
            if conductorConnected { c = .done }
            else if s.relayNeedUpdate { c = .failed(RelayStatus.updateServiceSentence) }
            else if s.relay?.state == .error || s.relay?.state == .unknown {
                let m = s.relay?.message ?? ""
                c = .failed(m.isEmpty ? "Conductor's link didn't come up. Try again." : m)
            }
            else if facts.connectBusy && serviceRunning && hooksInstalled { c = .working }
            else { c = .pending }
            rows.append(ConnectRow(id: "conductor", title: "Conductor's link", detail: nil, state: c))
        }
        return rows
    }

    /// The first failed row, which stops the run.
    public var connectFailure: ConnectRow? { connectRows.first { $0.state.isFailed } }

    /// What to run next, once the person has pressed Connect. Each action runs once per press (`attempted`);
    /// a failure stops the run and waits for the person.
    public func nextConnectAction(attempted: Set<ConnectAction>) -> ConnectAction? {
        let s = facts.setup
        if facts.connectBusy { return nil }
        if !serviceRunning {
            if case .installing = s.service { return nil }
            return attempted.contains(.service) ? nil : .service
        }
        if !agentsFound.isEmpty, !hooksInstalled {
            if s.hooksNeedUpdate || attempted.contains(.hooks) { return nil }
            return .hooks
        }
        if conductorNeeded, !conductorConnected {
            if s.relayNeedUpdate || attempted.contains(.conductor) { return nil }
            return .conductor
        }
        return nil
    }

    // MARK: Stages

    private func factsDone(_ s: SetupStage) -> Bool {
        switch s {
        case .welcome: progress.started || isReturning
        case .connect: connectReady
        case .firstWin: facts.hasActiveSession
        case .away: facts.awayConfigured
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
    /// a working Squeak goes straight to Done.
    public var startStage: SetupStage {
        if progress.finished || isReturning { return .done }
        return stages.first { $0 != .done && state($0) == .todo } ?? .done
    }

    public func next(after s: SetupStage) -> SetupStage? {
        guard let i = stages.firstIndex(of: s), i + 1 < stages.count else { return nil }
        return stages[i + 1]
    }

    /// Every screen has a Back except Welcome (nothing before it) and Connect (it only moves on once it worked).
    public func previous(before s: SetupStage) -> SetupStage? {
        guard s != .connect, s != .welcome, let i = stages.firstIndex(of: s), i > 0 else { return nil }
        return stages[i - 1]
    }

    public func canContinue(_ s: SetupStage) -> Bool { s == .connect ? connectReady : true }

    /// What Settings › Setup still offers: neither done nor finished.
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
    public static let base = "https://squeak-mac.web.app/"

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

    public static func url(fromPairingURL url: String) -> String? {
        payload(fromPairingURL: url).map { base + "#pair=" + $0 }
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
