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
        public var hostPlist: URL { launchAgents.appending(path: "\(DaemonService.hostLabel).plist") }
        public var hostLogFile: URL { logFile.deletingLastPathComponent().appending(path: "squeak-host.log") }
        public var tokenFile: URL { supportDir.appending(path: "hook-token") }
        public var failedMarker: URL { root.appending(path: "failed-version") }
        public var failureFile: URL { root.appending(path: "failure.json") }
        /// Written by the daemon from its first instant: `{ pid, version, phase, at, error? }`.
        public var startupFile: URL { supportDir.appending(path: "startup.json") }
    }

    public typealias Health = @Sendable () async -> Bool
    /// `GET /native/sessions` on the session host, with the control token.
    public typealias HostSessions = @Sendable (_ tokenFile: URL) async -> HostProbe

    private let paths: Paths
    private let runner: DaemonService.Runner
    private let uid: UInt32
    private let health: Health
    private let sleep: @Sendable (Double) async -> Void
    private let healthSeconds: Double
    private let hostSessions: HostSessions
    private var fm: FileManager { .default }

    public init(paths: Paths = .standard(), uid: UInt32 = getuid(), runner: @escaping DaemonService.Runner = DaemonService.run,
                health: @escaping Health = LiveDaemonEffects.stateAnswers, healthSeconds: Double = 40,
                hostSessions: @escaping HostSessions = LiveDaemonEffects.liveHostSessions,
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) {
        self.paths = paths
        self.uid = uid
        self.runner = runner
        self.health = health
        self.healthSeconds = healthSeconds
        self.hostSessions = hostSessions
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

    public static let liveHostSessions: HostSessions = { tokenFile in
        let port = ProcessInfo.processInfo.environment["SQUEAK_HOST_PORT"].flatMap { Int($0) } ?? NativeHostClient.defaultPort
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/native/sessions")!)
        request.timeoutInterval = 3
        if let token = DaemonClient.readToken(at: tokenFile) { request.setValue(token, forHTTPHeaderField: "x-squeak-token") }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sessions = object["sessions"] as? [[String: Any]] else { return .unreadable }
            return .sessions(statuses: sessions.compactMap { $0["status"] as? String })
        } catch let error as URLError where error.code == .cannotConnectToHost || error.code == .networkConnectionLost {
            return .down
        } catch {
            return .unreadable
        }
    }

    // MARK: Reading

    public func gatherFacts(userRequested: Bool) async -> DaemonFacts {
        let failedVersion = try? String(contentsOf: paths.failedMarker, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        let failure = Self.readFailure(paths)
        return DaemonFacts(
            plistArguments: readPlistArguments(),
            installedVersion: try? String(contentsOf: paths.current.appending(path: "VERSION"), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
            bundledVersion: try? String(contentsOf: paths.bundleDaemon.appending(path: "VERSION"), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
            portAnswers: await health(),
            failedVersion: failedVersion,
            failedReason: failure?.version == failedVersion ? failure?.reason : nil,
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
        if fm.fileExists(atPath: final.appending(path: "VERSION").path) {
            if Quarantine.isQuarantined(final.appending(path: "node")) { Quarantine.strip(under: final) }
            return
        }
        let partial = paths.root.appending(path: ".partial-\(version)")
        try? fm.removeItem(at: partial)
        try? fm.removeItem(at: final)
        try fm.copyItem(at: paths.bundleDaemon, to: partial)  // keeps signatures: plain byte copies
        Quarantine.strip(under: partial)  // a downloaded app's copy is flagged, and launchd's exec of its node would never return
        try fm.moveItem(at: partial, to: final)
    }

    /// An installed version found flagged (an earlier build copied it that way): clear it, inside our own folder only.
    public func repairQuarantine() {
        guard let name = currentVersionDirectory() else { return }
        let dir = paths.root.appending(path: name)
        if Quarantine.isQuarantined(dir.appending(path: "node")) || Quarantine.isQuarantined(dir) { Quarantine.strip(under: dir) }
    }

    public func backgroundApproval() -> BackgroundApproval {
        guard fm.fileExists(atPath: paths.plist.path) else { return .unknown }
        return BackgroundApproval.current(plist: paths.plist)
    }

    /// Try again from nothing: unload and delete what a failed start left (our version folder, the markers, our launch
    /// agent), so the whole setup runs again. Touches only the daemon folder and our own plists.
    public func resetForRetry() async {
        await bootout()
        let failedVersion = (try? String(contentsOf: paths.failedMarker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let currentName = currentVersionDirectory()
        try? fm.removeItem(at: paths.failedMarker)
        try? fm.removeItem(at: paths.failureFile)
        for name in (try? fm.contentsOfDirectory(atPath: paths.root.path)) ?? [] where name.hasPrefix(".partial-") || name.hasPrefix(".current-") {
            try? fm.removeItem(at: paths.root.appending(path: name))
        }
        if let v = failedVersion, !v.isEmpty, !v.contains("/") { try? fm.removeItem(at: paths.root.appending(path: v)) }
        // A `current` that points at a start that never worked goes too: the next install makes a fresh one.
        if let c = currentName, c == failedVersion || !fm.fileExists(atPath: paths.root.appending(path: c).appending(path: "VERSION").path) {
            try? fm.removeItem(at: paths.current)
        }
        if let args = readPlistArguments() {
            if args.contains(where: { $0.hasPrefix(paths.root.path + "/") }) { try? fm.removeItem(at: paths.plist) }
        } else if fm.fileExists(atPath: paths.plist.path) {
            try? fm.removeItem(at: paths.plist)  // half-written: unreadable as a property list
        }
        if hostPlistArguments() == nil, fm.fileExists(atPath: paths.hostPlist.path) { try? fm.removeItem(at: paths.hostPlist) }
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
        let kept: Set<String> = ["current", "failed-version", "failure.json"]
        for name in names where !name.hasPrefix(".") && !kept.contains(name) && !keeping.contains(name) {
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

    // MARK: Why it failed

    public static func readFailure(_ paths: Paths = .standard()) -> DaemonFailure? {
        guard let data = try? Data(contentsOf: paths.failureFile) else { return nil }
        return try? JSONDecoder().decode(DaemonFailure.self, from: data)
    }

    public func recordFailure(_ failure: DaemonFailure?) {
        guard let failure else { try? fm.removeItem(at: paths.failureFile); return }
        try? fm.createDirectory(at: paths.root, withIntermediateDirectories: true)
        try? JSONEncoder().encode(failure).write(to: paths.failureFile, options: .atomic)
    }

    public func logMark() -> UInt64 {
        ((try? fm.attributesOfItem(atPath: paths.logFile.path))?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    public func diagnose(version: String, logFrom: UInt64) async -> DaemonFailure {
        var e = DaemonEvidence(appleSilicon: Self.isAppleSilicon())
        let probe = await Self.capture(paths.current.appending(path: "node").path, ["-v"], timeout: 15)
        e.probeExit = probe.exit; e.probeSignal = probe.signal; e.probeTimedOut = probe.timedOut; e.probeOutput = probe.output
        e.log = readLog(from: logFrom)
        e.startup = Self.startupText(paths)
        e.launchd = await Self.launchdSummary(target)
        return DaemonDiagnosis.failure(e, version: version)
    }

    /// At most the last 64 KB the service wrote since `offset` (all of it if the log was rotated meanwhile).
    func readLog(from offset: UInt64) -> String {
        guard let h = try? FileHandle(forReadingFrom: paths.logFile) else { return "" }
        defer { try? h.close() }
        let end = (try? h.seekToEnd()) ?? 0
        let start = end < offset ? 0 : max(offset, end > 65_536 ? end - 65_536 : 0)
        try? h.seek(toOffset: start)
        return String(decoding: (try? h.readToEnd()) ?? Data(), as: UTF8.self)
    }

    public static func isAppleSilicon() -> Bool {
        var value: Int32 = 0
        var size = MemoryLayout<Int32>.size
        return sysctlbyname("hw.optional.arm64", &value, &size, nil, 0) == 0 && value == 1
    }

    typealias Probe = CapturedRun

    /// Runs a program, keeps what it prints, and kills it after `timeout` seconds (and answers even if it never ends).
    static func capture(_ path: String, _ args: [String], timeout: Double, grace: Double = 2) async -> Probe {
        await ProcessCapture.run(path, args, timeout: timeout, grace: grace)
    }

    // MARK: The session host

    public func hostPlistArguments() -> [String]? {
        guard let data = try? Data(contentsOf: paths.hostPlist),
              let obj = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let args = obj["ProgramArguments"] as? [String] else { return nil }
        return args
    }

    public func hostLoaded() async -> Bool { ((try? await runner("/bin/launchctl", ["print", "\(domain)/\(DaemonService.hostLabel)"])) ?? 1) == 0 }

    public func hostProbe() async -> HostProbe { await hostSessions(paths.tokenFile) }

    public func writeHostPlist() throws {
        try fm.createDirectory(at: paths.launchAgents, withIntermediateDirectories: true)
        try fm.createDirectory(at: paths.hostLogFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        let home = URL.homeDirectory.path
        let text = DaemonInstaller.hostPlistText(
            nodePath: paths.current.appending(path: "node").path,
            cliPath: paths.current.appending(path: "dist/squeak/cli.js").path,
            logPath: paths.hostLogFile.path,
            path: "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        if let existing = try? String(contentsOf: paths.hostPlist, encoding: .utf8), existing == text { return }
        try text.write(to: paths.hostPlist, atomically: true, encoding: .utf8)
    }

    public func bootstrapHost() async -> Bool {
        let target = "\(domain)/\(DaemonService.hostLabel)"
        for attempt in 0..<3 {
            if ((try? await runner("/bin/launchctl", ["print", target])) ?? 1) == 0 { return true }
            if ((try? await runner("/bin/launchctl", ["bootstrap", domain, paths.hostPlist.path])) ?? 1) == 0 { return true }
            if attempt < 2 { await sleep(1) }
        }
        return false
    }

    public func kickstartHost() async -> Bool {
        guard await hostLoaded() else { return false }
        return ((try? await runner("/bin/launchctl", ["kickstart", "-k", "\(domain)/\(DaemonService.hostLabel)"])) ?? 1) == 0
    }

    // MARK: launchctl

    private func isLoaded() async -> Bool { ((try? await runner("/bin/launchctl", ["print", target])) ?? 1) == 0 }

    /// Retries: a bootstrap straight after a bootout fails with "Input/output error".
    public func bootstrap() async -> Bool {
        if !fm.fileExists(atPath: paths.plist.path) { try? writePlist() }
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

    // MARK: Watching a start

    public func pause(_ seconds: Double) async { await sleep(seconds) }

    /// `startup.json`, decoded leniently (`at` may be a number or text).
    struct Startup: Equatable {
        var pid: Int?
        var phase: String?
        var at: String?
        var error: String?
    }

    static func readStartup(_ paths: Paths) -> Startup? {
        guard let data = try? Data(contentsOf: paths.startupFile),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return Startup(pid: (o["pid"] as? NSNumber)?.intValue, phase: o["phase"] as? String,
                       at: o["at"].map { "\($0)" }, error: o["error"] as? String)
    }

    /// The file as written, for "Copy details" and a report.
    public static func startupText(_ paths: Paths = .standard()) -> String {
        guard let text = try? String(contentsOf: paths.startupFile, encoding: .utf8) else { return "" }
        return String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1_000))
    }

    struct Launchd: Equatable {
        var loaded = false
        var pid: Int?
        var runs: Int?
        var lastExit: Int?
        var state: String?
    }

    static func parseLaunchd(_ text: String) -> Launchd {
        var l = Launchd(loaded: true)
        for raw in text.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            func value(_ key: String) -> String? { line.hasPrefix(key) ? String(line.dropFirst(key.count)).trimmingCharacters(in: .whitespaces) : nil }
            if let v = value("pid = ") { l.pid = Int(v) }
            if let v = value("runs = ") { l.runs = Int(v) }
            if let v = value("last exit code = ") { l.lastExit = Int(v) }
            if let v = value("state = ") { l.state = v }
        }
        return l
    }

    static func launchdSummary(_ target: String) async -> String {
        let r = await capture("/bin/launchctl", ["print", target], timeout: 5)
        if r.exit != 0 { return "not loaded (launchctl exit \(r.exit.map(String.init) ?? "none"))" }
        let keys = ["state = ", "pid = ", "runs = ", "last exit code = ", "last terminating signal = "]
        let facts = r.output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { l in keys.contains { l.hasPrefix($0) } }
        return facts.isEmpty ? "loaded" : facts.joined(separator: ", ")
    }

    /// "1:02.50" or "1:02:03" (ps cputime) in seconds.
    static func parseCPUTime(_ text: String) -> Double? {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ":").map { Double($0) }
        guard !parts.isEmpty, !parts.contains(where: { $0 == nil }) else { return nil }
        return parts.compactMap { $0 }.reduce(0) { $0 * 60 + $1 }
    }

    public func startSample(elapsed: Double) async -> StartSample? {
        async let healthy = health()
        let ctl = await Self.capture("/bin/launchctl", ["print", target], timeout: 5)
        let l = ctl.exit == 0 ? Self.parseLaunchd(ctl.output) : Launchd()
        let alive = l.pid.map { $0 > 0 && kill(pid_t($0), 0) == 0 } ?? false
        var cpu: Double?
        if alive, let pid = l.pid {
            cpu = Self.parseCPUTime((await Self.capture("/bin/ps", ["-o", "cputime=", "-p", "\(pid)"], timeout: 3)).output)
        }
        // A startup.json that names another process is an earlier run's: ignore it.
        var startup = Self.readStartup(paths)
        if let s = startup, let p = s.pid, let live = l.pid, p != live { startup = nil }
        return StartSample(elapsed: elapsed, healthy: await healthy, phase: startup?.phase, phaseAt: startup?.at, error: startup?.error,
                           loaded: l.loaded, pidAlive: alive, cpuSeconds: cpu, runs: l.runs, lastExit: l.lastExit)
    }

    public func isStarting() async -> Bool {
        guard await !health() else { return false }
        let ctl = await Self.capture("/bin/launchctl", ["print", target], timeout: 5)
        guard ctl.exit == 0, let pid = Self.parseLaunchd(ctl.output).pid, pid > 0, kill(pid_t(pid), 0) == 0 else { return false }
        if let s = Self.readStartup(paths), s.phase == "failed" { return false }
        return true
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
