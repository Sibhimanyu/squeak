import Foundation

/// "2.0.0+abc1234": the package version and git short sha written to `daemon/VERSION` in the bundle.
public struct DaemonVersion: Equatable, Sendable, Comparable {
    public let raw: String
    public let numbers: [Int]

    public init?(_ raw: String?) {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let base = raw.split(separator: "+", maxSplits: 1).first.map(String.init) ?? raw
        let parts = base.split(separator: "-", maxSplits: 1).first.map(String.init) ?? base
        let nums = parts.split(separator: ".").compactMap { Int($0) }
        guard !nums.isEmpty else { return nil }
        self.raw = raw
        self.numbers = nums
    }

    /// Numeric order only; two builds of one package version tie (their sha differs, see `isNewerBuild`).
    public static func < (a: DaemonVersion, b: DaemonVersion) -> Bool {
        for i in 0..<max(a.numbers.count, b.numbers.count) {
            let x = i < a.numbers.count ? a.numbers[i] : 0
            let y = i < b.numbers.count ? b.numbers[i] : 0
            if x != y { return x < y }
        }
        return false
    }

    /// Whether installing `self` over `installed` is an update: a higher number, or the same number
    /// from a different build (package.json's version rarely moves between app releases). Never a downgrade.
    public func replaces(_ installed: DaemonVersion) -> Bool {
        if installed < self { return true }
        if self < installed { return false }
        return raw != installed.raw
    }
}

public enum DaemonStatus: Equatable, Sendable {
    /// This build of the app carries no daemon (a `swift run` build).
    case unavailable
    case notInstalled
    /// The launch agent runs a git checkout (the owner's dev loop): never touched.
    case devCheckout
    /// A daemon answers on the port but no agent of ours owns it.
    case external
    case upToDate(String)
    case updating(String)
    /// macOS has Squeak's background item switched off (Login Items): the person must allow it first.
    case needsApproval
    case failed(reason: String, running: String?)

    public var label: String {
        switch self {
        case .unavailable: "Not in this build"
        case .notInstalled: "Not installed"
        case .devCheckout: "Running from a checkout"
        case .external: "Running (not managed by Squeak)"
        case .upToDate: "Running"
        case .updating: "Updating…"
        case .needsApproval: "Needs permission"
        case .failed: "Needs attention"
        }
    }
}

/// Everything the planner looks at, gathered by the side-effect layer.
public struct DaemonFacts: Equatable, Sendable {
    /// `ProgramArguments` of ~/Library/LaunchAgents/com.squeak.daemon.plist; nil: no plist.
    public var plistArguments: [String]?
    public var installedVersion: String?
    public var bundledVersion: String?
    public var portAnswers: Bool
    /// The bundled version an earlier update to failed and was rolled back from.
    public var failedVersion: String?
    /// Why that version failed, in words, when it was saved.
    public var failedReason: String?
    /// The person pressed Install or Repair.
    public var userRequested: Bool
    public var supportDaemonRoot: String

    public init(plistArguments: [String]? = nil, installedVersion: String? = nil, bundledVersion: String? = nil,
                portAnswers: Bool = false, failedVersion: String? = nil, failedReason: String? = nil,
                userRequested: Bool = false, supportDaemonRoot: String) {
        self.plistArguments = plistArguments
        self.installedVersion = installedVersion
        self.bundledVersion = bundledVersion
        self.portAnswers = portAnswers
        self.failedVersion = failedVersion
        self.failedReason = failedReason
        self.userRequested = userRequested
        self.supportDaemonRoot = supportDaemonRoot
    }

    /// An agent is ours when it runs from the support directory (or, from an early build, from inside an app bundle).
    public var plistIsManaged: Bool {
        guard let args = plistArguments else { return false }
        return args.contains { $0.hasPrefix(supportDaemonRoot + "/") || $0.contains(".app/Contents/Resources/daemon/") }
    }
}

public enum DaemonPlan: Equatable, Sendable {
    case nothing(DaemonStatus)
    case install
    case update(from: String?)
    /// Kickstart (or bootstrap) the current version; Repair on an agent that is already up to date.
    case restart
}

public enum DaemonInstaller {
    public static func plan(_ f: DaemonFacts) -> DaemonPlan {
        guard let bundled = DaemonVersion(f.bundledVersion) else { return .nothing(.unavailable) }

        // (a) An agent that is not ours is a dev/owner install: never replaced, even on request.
        if f.plistArguments != nil && !f.plistIsManaged { return .nothing(.devCheckout) }

        // (b) No agent.
        if f.plistArguments == nil {
            if f.portAnswers { return .nothing(.external) }
            if f.userRequested { return .install }
            // A first install that failed earlier: say why again rather than look untouched.
            if f.failedVersion == bundled.raw {
                return .nothing(.failed(reason: f.failedReason ?? DaemonDiagnosis.slowStart, running: nil))
            }
            return .nothing(.notInstalled)
        }

        // (c) Ours.
        let installed = DaemonVersion(f.installedVersion)
        if let installed {
            if bundled.replaces(installed) {
                if f.failedVersion == bundled.raw && !f.userRequested {
                    return .nothing(.failed(reason: "Version \(bundled.raw) did not start and was rolled back. Repair tries again.", running: installed.raw))
                }
                return .update(from: installed.raw)
            }
            // Silent at launch: the app was quit mid-install, or the service is stuck. Start it again.
            return f.userRequested || !f.portAnswers ? .restart : .nothing(.upToDate(installed.raw))
        }
        // An agent of ours with no usable installed copy (an early in-app path, or a broken `current`).
        return .update(from: nil)
    }

    /// Whether a failed update should roll back: only when there is a version to return to.
    public static func rollbackTarget(previous: String?, new: String) -> String? {
        guard let previous, !previous.isEmpty, previous != new else { return nil }
        return previous
    }

    /// Which version directories to keep: the current one, the one before it, and nothing else.
    public static func versionsToKeep(current: String, previous: String?) -> Set<String> {
        var keep: Set<String> = [current]
        if let previous { keep.insert(previous) }
        return keep
    }

    /// The launch agent's property list: the same content as scripts/install-squeak-agents.sh writes for
    /// com.squeak.daemon (KeepAlive true, ThrottleInterval 10, one shared log), pointing at the `current` link.
    public static func plistText(nodePath: String, cliPath: String, logPath: String) -> String {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        }
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>com.squeak.daemon</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(esc(nodePath))</string>
                <string>\(esc(cliPath))</string>
                <string>start</string>
            </array>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <true/>
            <key>ThrottleInterval</key>
            <integer>10</integer>
            <key>StandardOutPath</key>
            <string>\(esc(logPath))</string>
            <key>StandardErrorPath</key>
            <string>\(esc(logPath))</string>
        </dict>
        </plist>

        """
    }
}


/// What the session host (com.squeak.host, `squeak host`) needs next, beside the daemon.
public enum HostPlan: Equatable, Sendable {
    /// Not ours (a plist that runs a git checkout, the dev loop): never written, loaded or restarted.
    case leaveAlone
    case nothing
    /// Write the plist and load it: no agent, or one that is not loaded.
    case install
    case restart
    /// A chat is working or waiting on a person: the host keeps its old version until the next update or restart.
    case deferRestart
}

/// What `GET /native/sessions` showed.
public enum HostProbe: Equatable, Sendable {
    /// Nothing listens: no turn can be running.
    case down
    case sessions(statuses: [String])
    /// It answered with something unreadable or a refusal: assume a turn may be running.
    case unreadable
}

extension DaemonInstaller {
    private static let busyStatuses: Set<String> = ["working", "cancelling", "stopping"]

    /// A restart ends every running turn, so it waits for none to be working, cancelling or `needs_*`.
    public static func hostIsBusy(_ probe: HostProbe) -> Bool {
        switch probe {
        case .down: return false
        case .unreadable: return true
        case .sessions(let statuses): return statuses.contains { busyStatuses.contains($0) || NativeStatus.isAwaitingPerson($0) || $0.hasPrefix("needs_") }
        }
    }

    public static func hostPlan(plistArguments: [String]?, supportDaemonRoot: String, loaded: Bool, daemonChanged: Bool, busy: Bool) -> HostPlan {
        if let args = plistArguments,
           !args.contains(where: { $0.hasPrefix(supportDaemonRoot + "/") || $0.contains(".app/Contents/Resources/daemon/") }) {
            return .leaveAlone
        }
        if plistArguments == nil || !loaded { return .install }
        guard daemonChanged else { return .nothing }
        return busy ? .deferRestart : .restart
    }

    /// The session host's launch agent: the daemon's conventions (KeepAlive true, ThrottleInterval 10, a log) with the
    /// `host` argument. Squeak finds Claude Code and Codex itself (src/native/binaries.ts), but a launch agent starts with
    /// almost no PATH and a `codex` shim runs `env node`, so the usual places are set too.
    public static func hostPlistText(nodePath: String, cliPath: String, logPath: String, path: String) -> String {
        func esc(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        }
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>\(DaemonService.hostLabel)</string>
            <key>ProgramArguments</key>
            <array>
                <string>\(esc(nodePath))</string>
                <string>\(esc(cliPath))</string>
                <string>host</string>
            </array>
            <key>EnvironmentVariables</key>
            <dict>
                <key>PATH</key>
                <string>\(esc(path))</string>
            </dict>
            <key>RunAtLoad</key>
            <true/>
            <key>KeepAlive</key>
            <true/>
            <key>ThrottleInterval</key>
            <integer>10</integer>
            <key>StandardOutPath</key>
            <string>\(esc(logPath))</string>
            <key>StandardErrorPath</key>
            <string>\(esc(logPath))</string>
        </dict>
        </plist>

        """
    }
}

/// Every side effect the installer performs, so tests drive the whole sequence with a fake.
public protocol DaemonEffects: Sendable {
    func gatherFacts(userRequested: Bool) async -> DaemonFacts
    /// The directory name `current` points at.
    func currentVersionDirectory() -> String?
    func copyBundle(version: String) throws
    func writePlist() throws
    func removePlist()
    func switchCurrent(to version: String) throws
    func bootstrap() async -> Bool
    /// Bootout, then waits until launchd no longer lists the job.
    func bootout() async
    func kickstart() async -> Bool
    func waitHealthy() async -> Bool
    func prune(keeping: Set<String>)
    func setFailedVersion(_ version: String?)
    /// Where the log ends now, so a diagnosis reads only what this try wrote.
    func logMark() -> UInt64
    /// Looks at the Mac, the installed Node and the log after a start that did not answer.
    func diagnose(version: String, logFrom: UInt64) async -> DaemonFailure
    /// Saves (or clears) why the last try failed.
    func recordFailure(_ failure: DaemonFailure?)
    /// Clears the flag macOS puts on a downloaded app's files from an installed copy that has it.
    func repairQuarantine()
    /// Whether macOS lets our launch agent run (checked with the plist on disk, before it is loaded).
    func backgroundApproval() -> BackgroundApproval
    /// Deletes what a failed start left behind, so the next run begins from nothing.
    func resetForRetry() async
    /// One look at a starting service; nil when these effects cannot look (the wait is then `waitHealthy`).
    func startSample(elapsed: Double) async -> StartSample?
    /// Between two looks.
    func pause(_ seconds: Double) async
    /// A process of ours is alive and has not answered yet: a start that is still going (the app was quit and reopened).
    func isStarting() async -> Bool

    // The session host (com.squeak.host). Best effort: nothing here may fail the daemon's install.
    func hostPlistArguments() -> [String]?
    func hostLoaded() async -> Bool
    func hostProbe() async -> HostProbe
    func writeHostPlist() throws
    func bootstrapHost() async -> Bool
    func kickstartHost() async -> Bool
}

public extension DaemonEffects {
    func logMark() -> UInt64 { 0 }
    func diagnose(version: String, logFrom: UInt64) async -> DaemonFailure {
        DaemonDiagnosis.failure(DaemonEvidence(), version: version)
    }
    func recordFailure(_ failure: DaemonFailure?) {}
    func repairQuarantine() {}
    func backgroundApproval() -> BackgroundApproval { .allowed }
    func resetForRetry() async {}
    func startSample(elapsed: Double) async -> StartSample? { nil }
    func pause(_ seconds: Double) async {}
    func isStarting() async -> Bool { false }
    // Effects that know nothing of the host leave it alone.
    func hostPlistArguments() -> [String]? { ["/dev/null"] }
    func hostLoaded() async -> Bool { true }
    func hostProbe() async -> HostProbe { .down }
    func writeHostPlist() throws {}
    func bootstrapHost() async -> Bool { true }
    func kickstartHost() async -> Bool { true }
}

/// What the installer is doing now, for the one line under the setup step.
public enum DaemonStep: Sendable, Equatable {
    case installing, checkingPermission, starting, waiting
    /// A slow first start that is alive: the phase it reached, in words.
    case patient(String)

    public var rawValue: String {
        switch self {
        case .installing: "Installing the background service…"
        case .checkingPermission: "Checking macOS's permission…"
        case .starting: "Starting it…"
        case .waiting: "Waiting for it to answer…"
        case .patient(let phase): "\(StartText.patience) \(phase)"
        }
    }
}

/// How a wait for the service ended.
enum StartResult: Equatable, Sendable {
    case healthy
    case failed(StartFailure)
}

public struct DaemonInstallerRunner: Sendable {
    private let effects: DaemonEffects
    public init(effects: DaemonEffects) { self.effects = effects }

    /// Decides and acts. `onStatus` hears `updating` before the work starts.
    public func reconcile(userRequested: Bool = false, onStatus: @Sendable (DaemonStatus) -> Void = { _ in },
                          onStep: @escaping @Sendable (DaemonStep) -> Void = { _ in }) async -> DaemonStatus {
        let (status, changed, root) = await reconcileDaemon(userRequested: userRequested, onStatus: onStatus, onStep: onStep)
        // The session host rides on the daemon's install, and never changes its result.
        if case .upToDate = status { await reconcileHost(daemonChanged: changed, root: root) }
        return status
    }

    /// Puts com.squeak.host in place for an install we own. Never throws, never rolls anything back, and never
    /// restarts a host while a chat is working or waiting (it then picks the new version up at the next update or restart).
    @discardableResult
    func reconcileHost(daemonChanged: Bool, root: String) async -> HostPlan {
        let args = effects.hostPlistArguments()
        let loaded = await effects.hostLoaded()
        // Asked only when a restart is on the table: the probe is a request to the host.
        let wantsRestart = daemonChanged && args != nil && loaded
        let busy = wantsRestart ? DaemonInstaller.hostIsBusy(await effects.hostProbe()) : false
        let plan = DaemonInstaller.hostPlan(plistArguments: args, supportDaemonRoot: root, loaded: loaded, daemonChanged: daemonChanged, busy: busy)
        switch plan {
        case .leaveAlone, .nothing, .deferRestart:
            break
        case .install:
            do {
                try effects.writeHostPlist()
                _ = await effects.bootstrapHost()
            } catch {}
        case .restart:
            do {
                try effects.writeHostPlist()
                if await !effects.kickstartHost() { _ = await effects.bootstrapHost() }
            } catch {}
        }
        return plan
    }

    /// Try again from the beginning: clear what a failed start left, then run the whole setup (permission check included).
    public func retryFromScratch(onStatus: @Sendable (DaemonStatus) -> Void = { _ in },
                                 onStep: @escaping @Sendable (DaemonStep) -> Void = { _ in }) async -> DaemonStatus {
        onStep(.installing)
        await effects.resetForRetry()
        return await reconcile(userRequested: true, onStatus: onStatus, onStep: onStep)
    }

    private func reconcileDaemon(userRequested: Bool, onStatus: @Sendable (DaemonStatus) -> Void,
                                 onStep: @escaping @Sendable (DaemonStep) -> Void) async -> (DaemonStatus, changed: Bool, root: String) {
        effects.repairQuarantine()
        let facts = await effects.gatherFacts(userRequested: userRequested)
        let root = facts.supportDaemonRoot
        guard let bundled = facts.bundledVersion.flatMap({ DaemonVersion($0)?.raw }) else { return (.unavailable, false, root) }
        switch DaemonInstaller.plan(facts) {
        case .nothing(let status):
            return (status, false, root)
        case .install:
            onStatus(.updating(bundled))
            let status = await install(bundled, onStep: onStep)
            return (status, true, root)
        case .update(let from):
            onStatus(.updating(bundled))
            let status = await update(to: bundled, from: from, onStep: onStep)
            return (status, true, root)
        case .restart:
            onStatus(.updating(facts.installedVersion ?? bundled))
            let running = facts.installedVersion ?? bundled
            let mark = effects.logMark()
            if effects.backgroundApproval() == .needsApproval { return (.needsApproval, false, root) }
            // The app was quit and reopened while the service was still starting: keep watching it, never kick it.
            var resumed = false
            if !userRequested { resumed = await effects.isStarting() }
            let result = resumed ? await awaitStart(upgrade: false, onStep) : await restartAgent(onStep)
            if result == .healthy {
                effects.recordFailure(nil)
                return (.upToDate(running), false, root)
            }
            guard case .failed(let f) = result else { return (.upToDate(running), false, root) }
            return (await failedStart(f, version: running, mark: mark, running: running), false, root)
        }
    }

    private func restartAgent(upgrade: Bool = false, _ onStep: @Sendable (DaemonStep) -> Void = { _ in }) async -> StartResult {
        onStep(.starting)
        if await !effects.kickstart() {
            if await !effects.bootstrap() { return .failed(.noProcess) }
        }
        return await awaitStart(upgrade: upgrade, onStep)
    }

    /// Waits for the port while the service is visibly alive and getting somewhere (up to 10 minutes for a first start).
    private func awaitStart(upgrade: Bool, _ onStep: @Sendable (DaemonStep) -> Void) async -> StartResult {
        onStep(.waiting)
        var watch = StartWatch(upgrade: upgrade)
        var elapsed = 0.0
        let step = 2.0
        await effects.pause(1)  // kickstart -k: let the old process go before asking
        while true {
            guard let sample = await effects.startSample(elapsed: elapsed) else {
                return await effects.waitHealthy() ? .healthy : .failed(.timedOut)  // effects that cannot look
            }
            switch watch.observe(sample) {
            case .success: return .healthy
            case .fail(let f), .rollback(let f): return .failed(f)
            case .wait(let words): if elapsed >= 6 { onStep(.patient(words)) }
            }
            await effects.pause(step)
            elapsed += step
        }
    }

    /// What a start that did not come up leaves behind. Never the plist: a slow service is left loaded to finish by
    /// itself, and a crash loop is only stopped (bootout) so the next launch can start it again.
    private func failedStart(_ f: StartFailure, version: String, mark: UInt64, running: String?) async -> DaemonStatus {
        let diagnosed = await effects.diagnose(version: version, logFrom: mark)
        if f.isDefinite { await effects.bootout() }
        let failure = DaemonFailure(version: version, reason: StartText.reason(f, diagnosed: diagnosed.reason), details: diagnosed.details)
        effects.recordFailure(failure)
        return .failed(reason: failure.reason, running: running)
    }

    private func install(_ version: String, onStep: @Sendable (DaemonStep) -> Void) async -> DaemonStatus {
        let mark = effects.logMark()
        onStep(.installing)
        do {
            try effects.copyBundle(version: version)
            try effects.switchCurrent(to: version)
            try effects.writePlist()  // on disk before anything is loaded
        } catch {
            return .failed(reason: "Could not install the background service: \(error.localizedDescription)", running: nil)
        }
        onStep(.checkingPermission)
        // Left in place when refused: the Login Items list shows it, and allowing it is what lets the next try load it.
        if effects.backgroundApproval() == .needsApproval { return .needsApproval }
        onStep(.starting)
        guard await effects.bootstrap() else {
            return await failedStart(.noProcess, version: version, mark: mark, running: nil)
        }
        let result = await awaitStart(upgrade: false, onStep)
        if result == .healthy {
            effects.setFailedVersion(nil)
            effects.recordFailure(nil)
            effects.prune(keeping: [version])
            return .upToDate(version)
        }
        // Nothing earlier to return to, so the plist stays: a service that is only slow finishes starting by itself.
        guard case .failed(let f) = result else { return .upToDate(version) }
        return await failedStart(f, version: version, mark: mark, running: nil)
    }

    private func update(to version: String, from installed: String?, onStep: @Sendable (DaemonStep) -> Void) async -> DaemonStatus {
        onStep(.installing)
        let previous = effects.currentVersionDirectory() ?? installed
        do {
            try effects.copyBundle(version: version)
            try effects.writePlist()  // before anything is unloaded; a no-op rewrite when it already matches
            try effects.switchCurrent(to: version)
        } catch {
            return .failed(reason: "Could not install the update: \(error.localizedDescription)", running: installed)
        }
        onStep(.checkingPermission)
        if effects.backgroundApproval() == .needsApproval { return .needsApproval }
        let started = await restartAgent(upgrade: true, onStep)
        if started == .healthy {
            effects.setFailedVersion(nil)
            effects.recordFailure(nil)
            effects.prune(keeping: DaemonInstaller.versionsToKeep(current: version, previous: previous))
            return .upToDate(version)
        }
        guard let back = DaemonInstaller.rollbackTarget(previous: previous, new: version) else {
            effects.setFailedVersion(version)
            return .failed(reason: "The new background service did not start and there was no earlier version to return to.", running: nil)
        }
        effects.setFailedVersion(version)
        do { try effects.switchCurrent(to: back) } catch {
            return .failed(reason: "The update failed and the rollback could not be made: \(error.localizedDescription)", running: nil)
        }
        let recovered = await restartAgent(upgrade: true) == .healthy
        effects.prune(keeping: DaemonInstaller.versionsToKeep(current: back, previous: nil))
        return recovered
            ? .failed(reason: "Version \(version) did not start; rolled back to \(back).", running: back)
            : .failed(reason: "Version \(version) did not start and \(back) did not either.", running: nil)
    }
}
