import Foundation

/// The one state machine behind every update surface (menu-bar popup banner, Settings › About, the update
/// window). It is pure: Sparkle's callbacks and the person's taps go in as `Event`s with the time they happened,
/// the new `phase` and a list of `Command`s for the adapter (`AppUpdater`) to carry out come out, and `tick(now:)`
/// moves a state that has waited too long to `failed`. No state can wait forever: each one has a timeout.
///
/// The adapter must feed every Sparkle callback in, whether or not the session was started by a person, so a
/// background (automatic) download shows its progress too.
public struct UpdateFlow: Equatable, Sendable {
    public enum Stage: String, Equatable, Sendable { case check, download, extract, install, relaunch }
    public enum Recovery: String, Equatable, Sendable { case tryAgain, downloadManually }

    public struct Failure: Equatable, Sendable {
        public var stage: Stage
        public var reason: String
        public var version: String?
        public var recoveries: [Recovery]
    }

    public enum Phase: Equatable, Sendable, CustomStringConvertible {
        case idle
        case checking
        case available(version: String)
        case downloading(version: String?, progress: Double?)
        case extracting(version: String?, progress: Double?)
        case readyToInstall(version: String)
        case installing(version: String?)
        case relaunching(version: String?)
        case failed(Failure)
        case upToDate

        /// A short name for the update log, with the version but never a progress number.
        public var description: String {
            switch self {
            case .idle: "idle"
            case .checking: "checking"
            case .available(let v): "available \(v)"
            case .downloading(let v, _): "downloading \(v ?? "?")"
            case .extracting(let v, _): "extracting \(v ?? "?")"
            case .readyToInstall(let v): "ready \(v)"
            case .installing(let v): "installing \(v ?? "?")"
            case .relaunching(let v): "relaunching \(v ?? "?")"
            case .failed(let f): "failed(\(f.stage.rawValue))"
            case .upToDate: "upToDate"
            }
        }

        /// Where an error arriving now belongs.
        public var failureStage: Stage {
            switch self {
            case .downloading: .download
            case .extracting: .extract
            case .readyToInstall, .installing: .install
            case .relaunching: .relaunch
            default: .check
            }
        }
    }

    /// What Sparkle can do for us right now.
    public enum SparkleState: Equatable, Sendable {
        /// No session: a check can start.
        case idle
        /// A user-initiated session found an update and waits for our reply.
        case awaitingChoice
        /// A session (often a background download) is running that we cannot start, join or cancel through Sparkle's API.
        case busy
    }

    public struct Timeouts: Equatable, Sendable {
        public var checking: TimeInterval = 60
        /// With no progress for this long a download counts as stalled.
        public var downloadStall: TimeInterval = 90
        public var extracting: TimeInterval = 120
        public var installing: TimeInterval = 120
        public var relaunching: TimeInterval = 120
        public init() {}
    }

    public enum Event: Equatable, Sendable {
        // The person
        case checkRequested(sparkle: SparkleState)
        case installRequested(sparkle: SparkleState)
        case restartRequested(canInstallNow: Bool)
        case retryRequested(sparkle: SparkleState, canInstallNow: Bool)
        case cancelRequested
        case dismissRequested
        // Sparkle
        case checkBegan(userInitiated: Bool)
        case updateFound(version: String)
        case noUpdate
        case downloadBegan(version: String?)
        case downloadProgress(Double?)
        case extractBegan
        case extractProgress(Double)
        case staged(version: String)
        case installBegan
        case willRelaunch
        case installed
        case failed(stage: Stage, reason: String, userInitiated: Bool)
        case canceledByUser
        /// The person chose "Skip This Version".
        case skipped
        /// Sparkle's `canCheckForUpdates` turned true: no session is running any more.
        case sparkleBecameIdle
        // Launch
        /// The app reopened on the version it had before a "Restart to update".
        case restartDidNotApply(target: String?, running: String)
        // Time
        case tick
    }

    public enum Command: Equatable, Sendable {
        case startCheck
        /// Reply "install" to the update Sparkle offered (now, or the moment it is offered).
        case acceptUpdate
        /// Quit and install the staged update (arms the relaunch watchdog).
        case installNow
        case cancelSession
        /// An attempt ended badly: reset the quit flags and disarm the relaunch watchdog.
        case endAttempt
    }

    public private(set) var phase: Phase = .idle
    /// The newest version Sparkle told us about, kept across phases so a failure can name it.
    public private(set) var knownVersion: String?
    /// When the current phase times out; nil when it has no limit.
    public private(set) var deadline: Date?
    /// The person pressed Install: accept the update the moment Sparkle offers it.
    public private(set) var pendingInstall = false
    /// A check or install is queued behind a Sparkle session we cannot control.
    public private(set) var waitingForSparkle = false
    private var retriedAfterSessionEnd = false
    public var timeouts: Timeouts

    public init(timeouts: Timeouts = Timeouts()) { self.timeouts = timeouts }

    // MARK: Events

    @discardableResult
    public mutating func handle(_ event: Event, now: Date) -> [Command] {
        switch event {
        case .checkRequested(let sparkle): return checkRequested(sparkle, now)
        case .installRequested(let sparkle): return installRequested(sparkle, now)
        case .restartRequested(let can): return restartRequested(can, now)
        case .retryRequested(let sparkle, let can): return retryRequested(sparkle, can, now)
        case .cancelRequested: return cancelRequested()
        case .dismissRequested:
            switch phase {
            case .failed(let f):
                if let v = f.version ?? knownVersion { phase = .available(version: v) } else { phase = .idle }
            case .upToDate: phase = .idle
            default: break
            }
            deadline = nil
            return []

        case .checkBegan(let userInitiated):
            guard userInitiated else { return [] }
            switch phase {
            case .idle, .upToDate, .available, .failed: enter(.checking, now)
            default: break
            }
            return []

        case .updateFound(let version):
            knownVersion = version
            switch phase {
            case .idle, .checking, .available, .upToDate:
                if pendingInstall {
                    enter(.downloading(version: version, progress: nil), now)
                    return [.acceptUpdate]
                }
                enter(.available(version: version), now)
            case .failed:
                if pendingInstall {
                    enter(.downloading(version: version, progress: nil), now)
                    return [.acceptUpdate]
                }
            case .downloading(_, let p):
                phase = .downloading(version: version, progress: p)
                // Queued by a press while Sparkle was busy: this is the offer it was waiting for.
                if pendingInstall, p == nil { return [.acceptUpdate] }
            case .extracting(_, let p): phase = .extracting(version: version, progress: p)
            case .readyToInstall, .installing, .relaunching: break
            }
            return []

        case .noUpdate:
            switch phase {
            case .checking, .downloading(_, nil):
                knownVersion = nil; pendingInstall = false; waitingForSparkle = false
                enter(.upToDate, now)
            case .available:
                knownVersion = nil
                enter(.idle, now)
            default: break
            }
            return []

        case .downloadBegan(let version):
            if let version { knownVersion = version }
            waitingForSparkle = false
            switch phase {
            case .readyToInstall, .installing, .relaunching: break
            default: enter(.downloading(version: version ?? knownVersion, progress: nil), now)
            }
            return []

        case .downloadProgress(let value):
            switch phase {
            case .downloading(let v, _): enter(.downloading(version: v, progress: value), now)
            case .readyToInstall, .installing, .relaunching, .extracting: break
            default: enter(.downloading(version: knownVersion, progress: value), now)
            }
            return []

        case .extractBegan:
            waitingForSparkle = false
            switch phase {
            case .readyToInstall, .installing, .relaunching: break
            default: enter(.extracting(version: knownVersion, progress: nil), now)
            }
            return []

        case .extractProgress(let value):
            switch phase {
            case .readyToInstall, .installing, .relaunching: break
            default: enter(.extracting(version: knownVersion, progress: value), now)
            }
            return []

        case .staged(let version):
            knownVersion = version; pendingInstall = false; waitingForSparkle = false; retriedAfterSessionEnd = false
            if case .installing = phase { return [] }
            if case .relaunching = phase { return [] }
            enter(.readyToInstall(version: version), now)
            return []

        case .installBegan:
            enter(.installing(version: knownVersion), now)
            return []

        case .willRelaunch:
            enter(.relaunching(version: knownVersion), now)
            return []

        case .installed:
            knownVersion = nil; pendingInstall = false
            enter(.idle, now)
            return []

        case .failed(let stage, let reason, let userInitiated):
            switch phase {
            case .idle, .available, .upToDate:
                // A background check or download that failed quietly is not worth a red banner.
                guard userInitiated || pendingInstall else { return [] }
            case .failed: return []
            default: break
            }
            return fail(stage, reason)

        case .canceledByUser:
            pendingInstall = false; waitingForSparkle = false
            switch phase {
            case .checking, .downloading, .extracting: enter(knownVersion.map { .available(version: $0) } ?? .idle, now)
            default: break
            }
            return []

        case .skipped:
            knownVersion = nil; pendingInstall = false; waitingForSparkle = false
            enter(.idle, now)
            return []

        case .sparkleBecameIdle: return sparkleBecameIdle(now)

        case .restartDidNotApply(let target, let running):
            if let target { knownVersion = target }
            phase = .failed(Failure(
                stage: .relaunch,
                reason: UpdateFlowCopy.restartDidNotApply(target: target, running: running),
                version: target, recoveries: [.tryAgain, .downloadManually]))
            deadline = nil
            return []

        case .tick: return tick(now: now)
        }
    }

    /// Moves a phase that has waited past its limit to `failed`.
    public mutating func tick(now: Date) -> [Command] {
        guard let deadline, now >= deadline else { return [] }
        waitingForSparkle = false
        switch phase {
        case .checking: return fail(.check, UpdateFlowCopy.timeoutReason(.check), cancel: true)
        case .downloading: return fail(.download, UpdateFlowCopy.timeoutReason(.download), cancel: true)
        case .extracting: return fail(.extract, UpdateFlowCopy.timeoutReason(.extract), cancel: true)
        case .installing: return fail(.install, UpdateFlowCopy.timeoutReason(.install))
        case .relaunching: return fail(.relaunch, UpdateFlowCopy.timeoutReason(.relaunch))
        default:
            self.deadline = nil
            return []
        }
    }

    // MARK: Person

    private mutating func checkRequested(_ sparkle: SparkleState, _ now: Date) -> [Command] {
        switch phase {
        case .checking, .downloading, .extracting, .installing, .relaunching, .readyToInstall:
            return []   // already in flight: the surfaces attach to it
        case .available where sparkle == .awaitingChoice:
            return []
        default: break
        }
        switch sparkle {
        case .idle:
            enter(.checking, now)
            return [.startCheck]
        case .awaitingChoice:
            if let v = knownVersion { enter(.available(version: v), now) }
            return []
        case .busy:
            waitingForSparkle = true
            enter(.checking, now)
            return []
        }
    }

    private mutating func installRequested(_ sparkle: SparkleState, _ now: Date) -> [Command] {
        switch phase {
        case .readyToInstall: return restartRequested(true, now)
        case .installing, .relaunching: return []
        case .downloading, .extracting:
            pendingInstall = true
            return []
        case .checking:
            pendingInstall = true
            return sparkle == .awaitingChoice ? [.acceptUpdate] : []
        default:
            pendingInstall = true
            retriedAfterSessionEnd = false
            enter(.downloading(version: knownVersion, progress: nil), now)
            switch sparkle {
            case .awaitingChoice: return [.acceptUpdate]
            case .idle: return [.startCheck]
            case .busy:
                waitingForSparkle = true
                return []
            }
        }
    }

    private mutating func restartRequested(_ canInstallNow: Bool, _ now: Date) -> [Command] {
        guard case .readyToInstall(let v) = phase else { return [] }
        guard canInstallNow else {
            return fail(.install, UpdateFlowCopy.installerGone)
        }
        enter(.installing(version: v), now)
        return [.installNow]
    }

    private mutating func retryRequested(_ sparkle: SparkleState, _ canInstallNow: Bool, _ now: Date) -> [Command] {
        guard case .failed(let f) = phase else { return [] }
        retriedAfterSessionEnd = false
        let version = f.version ?? knownVersion
        if (f.stage == .install || f.stage == .relaunch), canInstallNow, let version {
            phase = .readyToInstall(version: version)
            return restartRequested(true, now)
        }
        if let version {
            phase = .available(version: version)
            return installRequested(sparkle, now)
        }
        phase = .idle
        return checkRequested(sparkle, now)
    }

    private mutating func cancelRequested() -> [Command] {
        switch phase {
        case .checking, .downloading, .extracting:
            pendingInstall = false; waitingForSparkle = false; deadline = nil
            phase = knownVersion.map { .available(version: $0) } ?? .idle
            return [.cancelSession]
        default: return []
        }
    }

    // MARK: Sparkle idle

    private mutating func sparkleBecameIdle(_ now: Date) -> [Command] {
        switch phase {
        case .checking where waitingForSparkle:
            waitingForSparkle = false
            enter(.checking, now)
            return [.startCheck]
        case .downloading where waitingForSparkle:
            waitingForSparkle = false
            enter(.downloading(version: knownVersion, progress: nil), now)
            return [.startCheck]
        case .downloading, .extracting:
            // The session ended without an update staged: once more if the person asked for it, else say so.
            if pendingInstall, !retriedAfterSessionEnd {
                retriedAfterSessionEnd = true
                enter(.downloading(version: knownVersion, progress: nil), now)
                return [.startCheck]
            }
            return fail(.download, UpdateFlowCopy.sessionEnded)
        case .checking:
            enter(knownVersion.map { .available(version: $0) } ?? .idle, now)
            return []
        default: return []
        }
    }

    // MARK: Helpers

    private mutating func enter(_ new: Phase, _ now: Date) {
        phase = new
        switch new {
        case .checking: deadline = now.addingTimeInterval(timeouts.checking)
        case .downloading: deadline = now.addingTimeInterval(timeouts.downloadStall)
        case .extracting: deadline = now.addingTimeInterval(timeouts.extracting)
        case .installing: deadline = now.addingTimeInterval(timeouts.installing)
        case .relaunching: deadline = now.addingTimeInterval(timeouts.relaunching)
        default: deadline = nil
        }
    }

    private mutating func fail(_ stage: Stage, _ reason: String, cancel: Bool = false) -> [Command] {
        pendingInstall = false; waitingForSparkle = false; deadline = nil
        phase = .failed(Failure(stage: stage, reason: reason, version: knownVersion, recoveries: [.tryAgain, .downloadManually]))
        return cancel ? [.cancelSession, .endAttempt] : [.endAttempt]
    }
}

/// Every sentence the update surfaces show, and the buttons each phase offers, in one testable place.
public enum UpdateFlowCopy {
    public enum Action: String, Equatable, Sendable { case install, restart, cancel, tryAgain, downloadManually, dismiss }

    public static let installerGone = "The update is no longer waiting to install. Try again to fetch it."
    public static let sessionEnded = "The update stopped before it was ready. Try again."
    public static let cantStart = "Squeak's updater isn't ready yet. Try again in a moment."

    public static func timeoutReason(_ stage: UpdateFlow.Stage) -> String {
        switch stage {
        case .check: "Squeak couldn't reach the update server in time. Check your internet connection and try again."
        case .download: "The download stopped making progress. Check your internet connection and try again."
        case .extract: "Preparing the update took too long. Try again, or download Squeak by hand."
        case .install: "The update didn't start installing, so Squeak is still on the current version. Try again, or download Squeak by hand."
        case .relaunch: "Squeak didn't restart on its own. Try again, or download Squeak by hand."
        }
    }

    /// A plain sentence for a Sparkle error at a stage; the technical detail goes to the update log, not the banner.
    public static func failureReason(_ stage: UpdateFlow.Stage, offline: Bool) -> String {
        if offline { return "Squeak can't reach the update server. Check your internet connection and try again." }
        switch stage {
        case .check: return "Squeak couldn't check for updates. Try again in a moment."
        case .download: return "The update couldn't be downloaded. Try again, or download Squeak by hand."
        case .extract: return "The update couldn't be unpacked or verified. Try again, or download Squeak by hand."
        case .install: return "The update couldn't be installed. Try again, or download Squeak by hand."
        case .relaunch: return "Squeak couldn't restart after updating. Try again, or download Squeak by hand."
        }
    }

    public static func restartDidNotApply(target: String?, running: String) -> String {
        if let target { return "Squeak reopened on \(running), so the update to \(target) didn't install. Try again, or download Squeak by hand." }
        return "Squeak reopened on \(running), so the update didn't install. Try again, or download Squeak by hand."
    }

    /// The one-line status in the popup banner and Settings; nil when there is nothing to say.
    public static func status(_ phase: UpdateFlow.Phase) -> String? {
        func pct(_ p: Double?) -> String { p.map { " \(Int(($0 * 100).rounded()))%" } ?? "" }
        switch phase {
        case .idle: return nil
        case .checking: return "Checking for updates…"
        case .available(let v): return "Update \(v) available"
        case .downloading(let v, let p): return "Downloading \(v ?? "the update")…" + pct(p)
        case .extracting(let v, let p): return "Preparing \(v ?? "the update")…" + pct(p)
        case .readyToInstall(let v): return "Update \(v) is ready"
        case .installing(let v): return "Installing \(v ?? "the update")…"
        case .relaunching: return "Restarting Squeak…"
        case .failed(let f): return f.reason
        case .upToDate: return "Squeak is up to date"
        }
    }

    /// Buttons for a phase, in order. The surface hides `.cancel` when Sparkle gave it nothing to cancel with.
    public static func actions(_ phase: UpdateFlow.Phase) -> [Action] {
        switch phase {
        case .idle, .installing, .relaunching: []
        case .checking, .downloading, .extracting: [.cancel]
        case .available: [.install]
        case .readyToInstall: [.restart]
        case .failed(let f): f.recoveries.map { $0 == .tryAgain ? .tryAgain : .downloadManually } + [.dismiss]
        case .upToDate: [.dismiss]
        }
    }

    public static func label(_ action: Action) -> String {
        switch action {
        case .install: "Install"
        case .restart: "Restart to update"
        case .cancel: "Cancel"
        case .tryAgain: "Try again"
        case .downloadManually: "Download manually"
        case .dismiss: "Dismiss"
        }
    }

    /// True while the banner should show a spinner or bar.
    public static func isBusy(_ phase: UpdateFlow.Phase) -> Bool {
        switch phase {
        case .checking, .downloading, .extracting, .installing, .relaunching: true
        default: false
        }
    }

    public static func progress(_ phase: UpdateFlow.Phase) -> Double? {
        switch phase {
        case .downloading(_, let p), .extracting(_, let p): p
        default: nil
        }
    }

    public static let siteURL = URL(string: "https://sibhimanyu.github.io/squeak/")!

    /// The DMG for a version, or the download page when the version is missing or not a plain `1.2.3`.
    public static func manualDownloadURL(version: String?) -> URL {
        guard let version, !version.isEmpty, version.allSatisfy({ $0.isNumber || $0 == "." }), !version.hasPrefix("."), !version.hasSuffix(".") else { return siteURL }
        return URL(string: "https://sibhimanyu.github.io/squeak/download/Squeak-\(version).dmg") ?? siteURL
    }
}
