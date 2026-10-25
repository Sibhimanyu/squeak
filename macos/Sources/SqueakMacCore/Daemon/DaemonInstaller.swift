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
    case failed(reason: String, running: String?)

    public var label: String {
        switch self {
        case .unavailable: "Not in this build"
        case .notInstalled: "Not installed"
        case .devCheckout: "Running from a checkout"
        case .external: "Running (not managed by Squeak)"
        case .upToDate: "Running"
        case .updating: "Updating…"
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
    /// The person pressed Install or Repair.
    public var userRequested: Bool
    public var supportDaemonRoot: String

    public init(plistArguments: [String]? = nil, installedVersion: String? = nil, bundledVersion: String? = nil,
                portAnswers: Bool = false, failedVersion: String? = nil, userRequested: Bool = false,
                supportDaemonRoot: String) {
        self.plistArguments = plistArguments
        self.installedVersion = installedVersion
        self.bundledVersion = bundledVersion
        self.portAnswers = portAnswers
        self.failedVersion = failedVersion
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
            return f.userRequested ? .install : .nothing(.notInstalled)
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
            return f.userRequested ? .restart : .nothing(.upToDate(installed.raw))
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
}

public struct DaemonInstallerRunner: Sendable {
    private let effects: DaemonEffects
    public init(effects: DaemonEffects) { self.effects = effects }

    /// Decides and acts. `onStatus` hears `updating` before the work starts.
    public func reconcile(userRequested: Bool = false, onStatus: @Sendable (DaemonStatus) -> Void = { _ in }) async -> DaemonStatus {
        let facts = await effects.gatherFacts(userRequested: userRequested)
        guard let bundled = facts.bundledVersion.flatMap({ DaemonVersion($0)?.raw }) else { return .unavailable }
        switch DaemonInstaller.plan(facts) {
        case .nothing(let status):
            return status
        case .install:
            onStatus(.updating(bundled))
            return await install(bundled)
        case .update(let from):
            onStatus(.updating(bundled))
            return await update(to: bundled, from: from)
        case .restart:
            onStatus(.updating(facts.installedVersion ?? bundled))
            let running = facts.installedVersion ?? bundled
            let ok = await restartAgent()
            return ok ? .upToDate(running) : .failed(reason: "The background service did not answer after a restart.", running: running)
        }
    }

    private func restartAgent() async -> Bool {
        if await !effects.kickstart() {
            if await !effects.bootstrap() { return false }
        }
        return await effects.waitHealthy()
    }

    private func install(_ version: String) async -> DaemonStatus {
        do {
            try effects.copyBundle(version: version)
            try effects.switchCurrent(to: version)
            try effects.writePlist()  // on disk before anything is loaded
        } catch {
            return .failed(reason: "Could not install the background service: \(error.localizedDescription)", running: nil)
        }
        guard await effects.bootstrap() else {
            effects.removePlist()
            return .failed(reason: "launchd would not load the background service.", running: nil)
        }
        if await effects.waitHealthy() {
            effects.prune(keeping: [version])
            return .upToDate(version)
        }
        // No earlier version to return to; never leave a crash loop behind.
        await effects.bootout()
        effects.removePlist()
        effects.setFailedVersion(version)
        return .failed(reason: "The background service did not start. See ~/Library/Logs/squeak/squeak.log.", running: nil)
    }

    private func update(to version: String, from installed: String?) async -> DaemonStatus {
        let previous = effects.currentVersionDirectory() ?? installed
        do {
            try effects.copyBundle(version: version)
            try effects.writePlist()  // before anything is unloaded; a no-op rewrite when it already matches
            try effects.switchCurrent(to: version)
        } catch {
            return .failed(reason: "Could not install the update: \(error.localizedDescription)", running: installed)
        }
        let started = await restartAgent()
        if started {
            effects.setFailedVersion(nil)
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
        let recovered = await restartAgent()
        effects.prune(keeping: DaemonInstaller.versionsToKeep(current: back, previous: nil))
        return recovered
            ? .failed(reason: "Version \(version) did not start; rolled back to \(back).", running: back)
            : .failed(reason: "Version \(version) did not start and \(back) did not either.", running: nil)
    }
}
