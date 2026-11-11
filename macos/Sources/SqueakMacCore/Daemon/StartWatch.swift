import Foundation

/// One look at a starting background service: the port, the service's own `startup.json`, and launchd's view of the process.
public struct StartSample: Equatable, Sendable {
    /// Seconds since the start began.
    public var elapsed: Double
    /// 8477 answers.
    public var healthy: Bool
    /// `startup.json`'s phase (loading, config, database, fleet, listening, ready, failed), only when it belongs to the running process.
    public var phase: String?
    /// `startup.json`'s `at`, as written: any change means the service moved on.
    public var phaseAt: String?
    public var error: String?
    /// launchd lists the job.
    public var loaded: Bool
    public var pidAlive: Bool
    /// The process's CPU time so far.
    public var cpuSeconds: Double?
    /// launchd's `runs` count, and the last exit code (nil: never exited).
    public var runs: Int?
    public var lastExit: Int?

    public init(elapsed: Double, healthy: Bool = false, phase: String? = nil, phaseAt: String? = nil, error: String? = nil,
                loaded: Bool = true, pidAlive: Bool = true, cpuSeconds: Double? = nil, runs: Int? = nil, lastExit: Int? = nil) {
        self.elapsed = elapsed; self.healthy = healthy; self.phase = phase; self.phaseAt = phaseAt; self.error = error
        self.loaded = loaded; self.pidAlive = pidAlive; self.cpuSeconds = cpuSeconds; self.runs = runs; self.lastExit = lastExit
    }
}

public enum StartFailure: Equatable, Sendable {
    /// The service wrote phase "failed".
    case reported(String)
    /// It keeps starting and exiting.
    case crashLoop
    /// launchd has no process for it (bootstrap refused, or it never came back).
    case noProcess
    /// It is alive but has shown no sign of progress for a long while.
    case stalled
    /// Out of time.
    case timedOut

    /// Something a wait cannot fix; the others may still finish by themselves, so the service is left running.
    public var isDefinite: Bool {
        switch self {
        case .reported, .crashLoop, .noProcess: true
        case .stalled, .timedOut: false
        }
    }
}

public enum StartDecision: Equatable, Sendable {
    /// Keep waiting; the words say how far it got.
    case wait(String)
    case success
    /// First install (or a repair): say why, never uninstall.
    case fail(StartFailure)
    /// An upgrade that did not come up: go back to the last version that worked.
    case rollback(StartFailure)
}

/// Decides, sample by sample, whether a starting service is worth waiting for. Pure: the caller supplies the samples.
public struct StartWatch: Sendable {
    public static let firstStartBudget: Double = 600
    public static let upgradeBudget: Double = 120
    /// Alive and silent (no new phase, no CPU) for this long counts as stuck.
    public static let idleLimit: Double = 180
    /// No process for this long, with launchd still holding the job, counts as gone.
    public static let goneLimit: Double = 30

    public let upgrade: Bool
    public let budget: Double
    private var lastPhase: String?
    private var lastAt: String?
    private var lastCPU: Double?
    private var lastProgress: Double = 0
    private var baselineRuns: Int?
    private var deadSince: Double?

    public init(upgrade: Bool, budget: Double? = nil) {
        self.upgrade = upgrade
        self.budget = budget ?? (upgrade ? Self.upgradeBudget : Self.firstStartBudget)
    }

    public static func phaseWords(_ phase: String?) -> String {
        switch phase {
        case "config": "Reading its settings…"
        case "database": "Opening its database…"
        case "fleet": "Watching your sessions…"
        case "listening", "ready": "Almost ready…"
        default: "Loading…"
        }
    }

    public mutating func observe(_ s: StartSample) -> StartDecision {
        if s.healthy { return .success }
        if s.phase == "failed" { return fail(.reported(s.error ?? "")) }

        if baselineRuns == nil { baselineRuns = s.runs }
        if let runs = s.runs, let base = baselineRuns, runs - base >= 2, let code = s.lastExit, code != 0 { return fail(.crashLoop) }
        if !s.loaded && s.elapsed > 3 { return fail(.noProcess) }

        if s.pidAlive && s.loaded {
            deadSince = nil
        } else if s.loaded {
            if deadSince == nil { deadSince = s.elapsed }
            if s.elapsed - (deadSince ?? s.elapsed) > Self.goneLimit { return fail(.noProcess) }
        }

        var moved = false
        if s.phase != lastPhase || s.phaseAt != lastAt { moved = s.phase != nil || s.phaseAt != nil }
        if let cpu = s.cpuSeconds, let before = lastCPU, cpu - before > 0.05 { moved = true }
        lastPhase = s.phase; lastAt = s.phaseAt
        if let cpu = s.cpuSeconds { lastCPU = cpu }
        if moved { lastProgress = s.elapsed }

        if s.elapsed >= budget { return fail(.timedOut) }
        if s.pidAlive && s.elapsed - lastProgress > Self.idleLimit { return fail(.stalled) }
        return .wait(Self.phaseWords(s.phase))
    }

    private func fail(_ f: StartFailure) -> StartDecision { upgrade ? .rollback(f) : .fail(f) }
}

public enum StartText {
    public static let patience = "Starting the background service (first start can take a few minutes on Macs with security software)…"

    public static func reason(_ f: StartFailure, diagnosed: String) -> String {
        switch f {
        case .reported(let e):
            let line = e.trimmingCharacters(in: .whitespacesAndNewlines)
            return line.isEmpty ? diagnosed : "The background service stopped while starting: \(line.prefix(200))"
        case .crashLoop: return diagnosed == DaemonDiagnosis.slowStart ? "The background service keeps stopping while it starts. Show the log for why." : diagnosed
        case .noProcess: return diagnosed == DaemonDiagnosis.slowStart ? "macOS did not start the background service. Try again; if it repeats, copy the details." : diagnosed
        case .stalled, .timedOut:
            return "The background service is still starting. It is left running and may finish by itself; give it a few more minutes, or press Try again."
        }
    }
}
