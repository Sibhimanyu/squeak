import Foundation

/// The real filesystem, launchctl and HTTP behind `DaemonEffects`. Paths and the runner are injected,
/// so tests run it against a temp directory with a fake launchctl.
public struct LiveDaemonEffects: DaemonEffects {
    public struct Paths: Sendable {
        public var bundleDaemon: URL  // Squeak.app/Contents/Resources/daemon
        public var supportDir: URL  // ~/Library/Application Support/squeak
        public var launchAgents: URL
        public var logFile: URL
        public init(bundleDaemon: URL, supportDir: URL, launchAgents: URL, logFile: URL) {
            self.bundleDaemon = bundleDaemon
            self.supportDir = supportDir
            self.launchAgents = launchAgents
            self.logFile = logFile
        }
        public static func standard(bundle: Bundle = .main) -> Paths {
            let home = URL.homeDirectory
            return Paths(
                bundleDaemon: (bundle.resourceURL ?? bundle.bundleURL).appending(path: "daemon"),
                supportDir: home.appending(path: "Library/Application Support/squeak"),
                launchAgents: home.appending(path: "Library/LaunchAgents"),
                logFile: home.appending(path: "Library/Logs/squeak/squeak.log"))
        }
        public var root: URL { supportDir.appending(path: "daemon") }
        public var current: URL { root.appending(path: "current") }
        public var plist: URL { launchAgents.appending(path: "\(DaemonService.label).plist") }
        public var failedMarker: URL { root.appending(path: "failed-version") }
    }

    public typealias Health = @Sendable () async -> Bool

    private let paths: Paths
    private let runner: DaemonService.Runner
    private let uid: UInt32
    private let health: Health
    private let sleep: @Sendable (Double) async -> Void
    private let healthSeconds: Double
    private var fm: FileManager { .default }

    public init(paths: Paths = .standard(), uid: UInt32 = getuid(), runner: @escaping DaemonService.Runner = DaemonService.run,
                health: @escaping Health = LiveDaemonEffects.stateAnswers, healthSeconds: Double = 20,
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        self.paths = paths
        self.uid = uid
        self.runner = runner
        self.health = health
        self.healthSeconds = healthSeconds
        self.sleep = sleep
    }

    private var domain: String { "gui/\(uid)" }
    private var target: String { "\(domain)/\(DaemonService.label)" }

    public static let stateAnswers: Health = {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(DaemonClient.defaultPort)/state")!)
        request.timeoutInterval = 2
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    // MARK: Reading

    public func gatherFacts(userRequested: Bool) async -> DaemonFacts {
        DaemonFacts(
            plistArguments: readPlistArguments(),
            installedVersion: try? String(contentsOf: paths.current.appending(path: "VERSION"), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
            bundledVersion: try? String(contentsOf: paths.bundleDaemon.appending(path: "VERSION"), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
            portAnswers: await health(),
            failedVersion: try? String(contentsOf: paths.failedMarker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
            userRequested: userRequested,
            supportDaemonRoot: paths.root.path)
    }

    func readPlistArguments() -> [String]? {
        guard let data = try? Data(contentsOf: paths.plist),
              let obj = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let args = obj["ProgramArguments"] as? [String] else { return nil }
        return args
    }

    public func currentVersionDirectory() -> String? {
        (try? fm.destinationOfSymbolicLink(atPath: paths.current.path)).map { ($0 as NSString).lastPathComponent }
    }

    // MARK: Writing

    public func copyBundle(version: String) throws {
        try fm.createDirectory(at: paths.root, withIntermediateDirectories: true)
        let final = paths.root.appending(path: version)
        if fm.fileExists(atPath: final.appending(path: "VERSION").path) { return }
        let partial = paths.root.appending(path: ".partial-\(version)")
        try? fm.removeItem(at: partial)
        try? fm.removeItem(at: final)
        try fm.copyItem(at: paths.bundleDaemon, to: partial)  // keeps signatures: plain byte copies
        try fm.moveItem(at: partial, to: final)
    }

    public func writePlist() throws {
        try fm.createDirectory(at: paths.launchAgents, withIntermediateDirectories: true)
        try fm.createDirectory(at: paths.logFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let text = DaemonInstaller.plistText(
            nodePath: paths.current.appending(path: "node").path,
            cliPath: paths.current.appending(path: "dist/squeak/cli.js").path,
            logPath: paths.logFile.path)
        if let existing = try? String(contentsOf: paths.plist, encoding: .utf8), existing == text { return }
        try text.write(to: paths.plist, atomically: true, encoding: .utf8)
    }

    public func removePlist() { try? fm.removeItem(at: paths.plist) }

    /// Atomic: a new link beside `current`, renamed over it.
    public func switchCurrent(to version: String) throws {
        try fm.createDirectory(at: paths.root, withIntermediateDirectories: true)
        let tmp = paths.root.appending(path: ".current-\(UUID().uuidString)")
        try fm.createSymbolicLink(atPath: tmp.path, withDestinationPath: version)
        if rename(tmp.path, paths.current.path) != 0 {
            let code = errno
            try? fm.removeItem(at: tmp)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
    }

    public func prune(keeping: Set<String>) {
        guard let names = try? fm.contentsOfDirectory(atPath: paths.root.path) else { return }
        for name in names where !name.hasPrefix(".") && name != "current" && name != "failed-version" && !keeping.contains(name) {
            try? fm.removeItem(at: paths.root.appending(path: name))
        }
    }

    public func setFailedVersion(_ version: String?) {
        if let version {
            try? fm.createDirectory(at: paths.root, withIntermediateDirectories: true)
            try? version.write(to: paths.failedMarker, atomically: true, encoding: .utf8)
        } else {
            try? fm.removeItem(at: paths.failedMarker)
        }
    }

    // MARK: launchctl

    private func isLoaded() async -> Bool { ((try? await runner("/bin/launchctl", ["print", target])) ?? 1) == 0 }

    /// Retries: a bootstrap straight after a bootout fails with "Input/output error".
    public func bootstrap() async -> Bool {
        for attempt in 0..<3 {
            if await isLoaded() { return true }
            if ((try? await runner("/bin/launchctl", ["bootstrap", domain, paths.plist.path])) ?? 1) == 0 { return true }
            if attempt < 2 { await sleep(1) }
        }
        return await isLoaded()
    }

    public func bootout() async {
        guard await isLoaded() else { return }
        _ = try? await runner("/bin/launchctl", ["bootout", target])
        for _ in 0..<40 {
            if await !isLoaded() { return }
            await sleep(0.25)
        }
    }

    public func kickstart() async -> Bool {
        guard await isLoaded() else { return false }
        return ((try? await runner("/bin/launchctl", DaemonService.kickstartArguments(uid: uid))) ?? 1) == 0
    }

    public func waitHealthy() async -> Bool {
        var waited = 0.0
        await sleep(1)  // kickstart -k: let the old process go before asking
        while waited < healthSeconds {
            if await health() { return true }
            await sleep(1)
            waited += 1
        }
        return false
    }
}
