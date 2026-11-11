import Foundation
import Testing

@testable import SqueakMacCore

private let root = "/Users/x/Library/Application Support/squeak/daemon"

private func facts(plist: [String]? = nil, installed: String? = nil, bundled: String? = "2.0.0+bbb", port: Bool = false,
                   failed: String? = nil, requested: Bool = false) -> DaemonFacts {
    DaemonFacts(plistArguments: plist, installedVersion: installed, bundledVersion: bundled, portAnswers: port,
                failedVersion: failed, userRequested: requested, supportDaemonRoot: root)
}
private let managed = ["\(root)/current/node", "\(root)/current/dist/squeak/cli.js", "start"]
private let checkout = ["/usr/local/bin/node", "/Users/x/conductor/repos/squeak/dist/squeak/cli.js", "start"]

@Suite struct DaemonPlanTests {
    @Test func versionCompare() {
        let a = DaemonVersion("2.0.0+aaa")!, b = DaemonVersion("2.0.1+aaa")!, c = DaemonVersion("2.0.0+bbb")!
        #expect(a < b)
        #expect(b.replaces(a))
        #expect(!a.replaces(b))  // never a downgrade
        #expect(c.replaces(a))  // same number, another build
        #expect(!a.replaces(a))
        #expect(DaemonVersion("2.10.0")! > DaemonVersion("2.9.9")!)
        #expect(DaemonVersion("") == nil)
        #expect(DaemonVersion("nogit") == nil)
    }
    @Test func noBundledDaemon() {
        #expect(DaemonInstaller.plan(facts(bundled: nil)) == .nothing(.unavailable))
    }
    @Test func devCheckoutIsNeverTouched() {
        #expect(DaemonInstaller.plan(facts(plist: checkout, installed: nil)) == .nothing(.devCheckout))
        #expect(DaemonInstaller.plan(facts(plist: checkout, requested: true)) == .nothing(.devCheckout))
    }
    @Test func noAgent() {
        #expect(DaemonInstaller.plan(facts()) == .nothing(.notInstalled))
        #expect(DaemonInstaller.plan(facts(requested: true)) == .install)
        #expect(DaemonInstaller.plan(facts(port: true, requested: true)) == .nothing(.external))
    }
    @Test func managedUpdates() {
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.0.0+aaa")) == .update(from: "2.0.0+aaa"))
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.0.0+bbb", port: true)) == .nothing(.upToDate("2.0.0+bbb")))
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.1.0+zzz", port: true)) == .nothing(.upToDate("2.1.0+zzz")))
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: nil)) == .update(from: nil))
        #expect(DaemonInstaller.plan(facts(plist: ["/Applications/Squeak.app/Contents/Resources/daemon/node", "x"], installed: nil)) == .update(from: nil))
    }
    @Test func failedVersionIsNotRetriedUntilRepair() {
        let f = facts(plist: managed, installed: "2.0.0+aaa", failed: "2.0.0+bbb")
        if case .nothing(.failed) = DaemonInstaller.plan(f) {} else { Issue.record("expected failed") }
        var r = f; r.userRequested = true
        #expect(DaemonInstaller.plan(r) == .update(from: "2.0.0+aaa"))
    }
    /// Quit mid-install (or a stuck service): the next launch starts it again instead of calling it running.
    @Test func silentUpToDateServiceIsRestartedAtLaunch() {
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.0.0+bbb", port: false)) == .restart)
    }
    /// A first install that failed stays failed, with its reason, until the person tries again.
    @Test func failedFirstInstallIsRememberedWithItsReason() {
        let f = facts(failed: "2.0.0+bbb")
        var withReason = f; withReason.failedReason = "Intel chip."
        #expect(DaemonInstaller.plan(withReason) == .nothing(.failed(reason: "Intel chip.", running: nil)))
        #expect(DaemonInstaller.plan(f) == .nothing(.failed(reason: DaemonDiagnosis.slowStart, running: nil)))
        #expect(DaemonInstaller.plan(facts(failed: "1.0.0+old")) == .nothing(.notInstalled))
        var retry = f; retry.userRequested = true
        #expect(DaemonInstaller.plan(retry) == .install)
    }
    @Test func repairRestartsUpToDate() {
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.0.0+bbb", requested: true)) == .restart)
    }
    @Test func plistMirrorsInstallScript() {
        let text = DaemonInstaller.plistText(nodePath: "/n", cliPath: "/c.js", logPath: "/l.log")
        #expect(text.contains("<key>KeepAlive</key>\n    <true/>"))
        #expect(text.contains("<integer>10</integer>"))
        #expect(text.contains("<string>start</string>"))
        #expect(text.contains("com.squeak.daemon"))
    }
    @Test func keepsTwoVersions() {
        #expect(DaemonInstaller.versionsToKeep(current: "b", previous: "a") == ["a", "b"])
        #expect(DaemonInstaller.rollbackTarget(previous: nil, new: "b") == nil)
        #expect(DaemonInstaller.rollbackTarget(previous: "b", new: "b") == nil)
        #expect(DaemonInstaller.rollbackTarget(previous: "a", new: "b") == "a")
    }
}

/// Records every call; `healthy` decides each health wait in turn.
private final class FakeEffects: DaemonEffects, @unchecked Sendable {
    var calls: [String] = []
    var factsValue: DaemonFacts
    var current: String?
    var healthy: [Bool]
    var bootstrapOK = true
    var failed: String?
    init(facts: DaemonFacts, current: String?, healthy: [Bool]) { self.factsValue = facts; self.current = current; self.healthy = healthy }
    func gatherFacts(userRequested: Bool) async -> DaemonFacts { var f = factsValue; f.userRequested = userRequested; return f }
    func currentVersionDirectory() -> String? { current }
    func copyBundle(version: String) throws { calls.append("copy \(version)") }
    func writePlist() throws { calls.append("plist") }
    func removePlist() { calls.append("removePlist") }
    func switchCurrent(to version: String) throws { calls.append("switch \(version)"); current = version }
    func bootstrap() async -> Bool { calls.append("bootstrap"); return bootstrapOK }
    func bootout() async { calls.append("bootout") }
    func kickstart() async -> Bool { calls.append("kickstart"); return true }
    func waitHealthy() async -> Bool { calls.append("health"); return healthy.isEmpty ? false : healthy.removeFirst() }
    func prune(keeping: Set<String>) { calls.append("prune \(keeping.sorted().joined(separator: ","))") }
    func setFailedVersion(_ version: String?) { failed = version; calls.append("failed \(version ?? "nil")") }
    var recorded: DaemonFailure?
    func diagnose(version: String, logFrom: UInt64) async -> DaemonFailure {
        calls.append("diagnose")
        return DaemonFailure(version: version, reason: "why", details: "details")
    }
    func recordFailure(_ failure: DaemonFailure?) { recorded = failure }
}

@Suite struct DaemonRunnerTests {
    @Test func devCheckoutDoesNothing() async {
        let fx = FakeEffects(facts: facts(plist: checkout, installed: nil), current: nil, healthy: [])
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(s == .devCheckout)
        #expect(fx.calls.isEmpty)
    }
    @Test func firstInstallWritesPlistBeforeLoading() async {
        let fx = FakeEffects(facts: facts(), current: nil, healthy: [true])
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        #expect(s == .upToDate("2.0.0+bbb"))
        #expect(fx.calls == ["copy 2.0.0+bbb", "switch 2.0.0+bbb", "plist", "bootstrap", "health", "failed nil", "prune 2.0.0+bbb"])
        #expect(fx.recorded == nil)
    }
    @Test func slowFirstInstallIsNeverUninstalled() async {
        let fx = FakeEffects(facts: facts(), current: nil, healthy: [false])
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        if case .failed = s {} else { Issue.record("expected failed") }
        // A slow first start is never uninstalled: the plist stays and the service stays loaded to finish by itself.
        #expect(!fx.calls.contains("removePlist") && !fx.calls.contains("bootout"))
        #expect(s == .failed(reason: StartText.reason(.timedOut, diagnosed: "why"), running: nil))
        #expect(fx.recorded?.details == "details")
    }
    @Test func failedRestartSaysWhy() async {
        let fx = FakeEffects(facts: facts(plist: managed, installed: "2.0.0+bbb"), current: "2.0.0+bbb", healthy: [false])
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        #expect(s == .failed(reason: StartText.reason(.timedOut, diagnosed: "why"), running: "2.0.0+bbb"))
        #expect(fx.recorded?.details == "details")
    }
    @Test func updateSwitchesAndKeepsTwo() async {
        let fx = FakeEffects(facts: facts(plist: managed, installed: "2.0.0+aaa"), current: "2.0.0+aaa", healthy: [true])
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(s == .upToDate("2.0.0+bbb"))
        #expect(fx.calls == ["copy 2.0.0+bbb", "plist", "switch 2.0.0+bbb", "kickstart", "health", "failed nil", "prune 2.0.0+aaa,2.0.0+bbb"])
    }
    @Test func unhealthyUpdateRollsBack() async {
        let fx = FakeEffects(facts: facts(plist: managed, installed: "2.0.0+aaa"), current: "2.0.0+aaa", healthy: [false, true])
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(s == .failed(reason: "Version 2.0.0+bbb did not start; rolled back to 2.0.0+aaa.", running: "2.0.0+aaa"))
        #expect(fx.current == "2.0.0+aaa")
        #expect(fx.failed == "2.0.0+bbb")
        #expect(fx.calls.filter { $0 == "kickstart" }.count == 2)
        #expect(fx.calls.last == "prune 2.0.0+aaa")
    }
    @Test func rollbackThatAlsoFailsSaysSo() async {
        let fx = FakeEffects(facts: facts(plist: managed, installed: "2.0.0+aaa"), current: "2.0.0+aaa", healthy: [false, false])
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(s == .failed(reason: "Version 2.0.0+bbb did not start and 2.0.0+aaa did not either.", running: nil))
    }
    @Test func migrationWithNothingToReturnToIsFailureNotRollback() async {
        let fx = FakeEffects(facts: facts(plist: managed, installed: nil), current: nil, healthy: [false])
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        if case .failed(_, nil) = s {} else { Issue.record("expected failed with nothing running") }
        #expect(fx.calls.filter { $0.hasPrefix("switch") }.count == 1)
    }
}

private let hostManaged = ["\(root)/current/node", "\(root)/current/dist/squeak/cli.js", "host"]
private let hostCheckout = ["/usr/local/bin/node", "/Users/x/conductor/repos/squeak/dist/squeak/cli.js", "host"]

@Suite struct HostPlanTests {
    private func plan(_ args: [String]?, loaded: Bool = true, changed: Bool = false, busy: Bool = false) -> HostPlan {
        DaemonInstaller.hostPlan(plistArguments: args, supportDaemonRoot: root, loaded: loaded, daemonChanged: changed, busy: busy)
    }
    @Test func checkoutHostIsLeftAlone() {
        #expect(plan(hostCheckout, loaded: false, changed: true) == .leaveAlone)
    }
    @Test func missingOrUnloadedHostIsInstalled() {
        #expect(plan(nil, loaded: false) == .install)
        #expect(plan(hostManaged, loaded: false) == .install)
    }
    @Test func restartOnlyWithANewDaemonAndNothingRunning() {
        #expect(plan(hostManaged) == .nothing)
        #expect(plan(hostManaged, changed: true) == .restart)
        #expect(plan(hostManaged, changed: true, busy: true) == .deferRestart)
    }
    @Test func busyMeansWorkingCancellingOrNeeds() {
        #expect(!DaemonInstaller.hostIsBusy(.down))
        #expect(!DaemonInstaller.hostIsBusy(.sessions(statuses: ["idle", "error", "interrupted"])))
        for s in ["working", "cancelling", "needs_user_permission", "needs_plan_response", "needs_user_input"] {
            #expect(DaemonInstaller.hostIsBusy(.sessions(statuses: ["idle", s])), "\(s)")
        }
        #expect(DaemonInstaller.hostIsBusy(.unreadable))
    }
    @Test func plistRunsHostFromCurrentWithDaemonConventions() {
        let text = DaemonInstaller.hostPlistText(nodePath: "/n", cliPath: "/c.js", logPath: "/l.log", path: "/a:/b")
        #expect(text.contains("com.squeak.host"))
        #expect(text.contains("<string>host</string>"))
        #expect(text.contains("<key>KeepAlive</key>\n    <true/>"))
        #expect(text.contains("<integer>10</integer>"))
        #expect(text.contains("<string>/a:/b</string>"))
    }
}

/// A fake that also knows the host; the daemon half is healthy.
private final class HostFakeEffects: DaemonEffects, @unchecked Sendable {
    var calls: [String] = []
    var hostArgs: [String]?
    var loaded: Bool
    var probe: HostProbe
    var writeFails = false
    var bootstrapHostOK = true
    var daemonHealthy: Bool
    let factsValue: DaemonFacts
    init(facts: DaemonFacts, hostArgs: [String]?, loaded: Bool, probe: HostProbe = .down, daemonHealthy: Bool = true) {
        self.factsValue = facts; self.hostArgs = hostArgs; self.loaded = loaded; self.probe = probe; self.daemonHealthy = daemonHealthy
    }
    func gatherFacts(userRequested: Bool) async -> DaemonFacts { var f = factsValue; f.userRequested = userRequested; return f }
    func currentVersionDirectory() -> String? { "2.0.0+aaa" }
    func copyBundle(version: String) throws {}
    func writePlist() throws {}
    func removePlist() {}
    func switchCurrent(to version: String) throws {}
    func bootstrap() async -> Bool { true }
    func bootout() async {}
    func kickstart() async -> Bool { true }
    func waitHealthy() async -> Bool { daemonHealthy }
    func prune(keeping: Set<String>) {}
    func setFailedVersion(_ version: String?) {}
    func hostPlistArguments() -> [String]? { hostArgs }
    func hostLoaded() async -> Bool { loaded }
    func hostProbe() async -> HostProbe { calls.append("probe"); return probe }
    func writeHostPlist() throws { calls.append("hostPlist"); if writeFails { throw CocoaError(.fileWriteNoPermission) } }
    func bootstrapHost() async -> Bool { calls.append("hostBootstrap"); return bootstrapHostOK }
    func kickstartHost() async -> Bool { calls.append("hostKickstart"); return true }
}

@Suite struct HostRunnerTests {
    @Test func firstInstallAlsoLoadsTheHost() async {
        let fx = HostFakeEffects(facts: facts(), hostArgs: nil, loaded: false)
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        #expect(s == .upToDate("2.0.0+bbb"))
        #expect(fx.calls == ["hostPlist", "hostBootstrap"])
    }
    @Test func updateRestartsAnIdleHost() async {
        let fx = HostFakeEffects(facts: facts(plist: managed, installed: "2.0.0+aaa"), hostArgs: hostManaged, loaded: true, probe: .sessions(statuses: ["idle"]))
        _ = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(fx.calls == ["probe", "hostPlist", "hostKickstart"])
    }
    @Test func updateNeverRestartsABusyHost() async {
        for status in ["working", "cancelling", "needs_user_input"] {
            let fx = HostFakeEffects(facts: facts(plist: managed, installed: "2.0.0+aaa"), hostArgs: hostManaged, loaded: true, probe: .sessions(statuses: [status]))
            _ = await DaemonInstallerRunner(effects: fx).reconcile()
            #expect(fx.calls == ["probe"], "\(status)")
        }
    }
    @Test func upToDateDaemonLeavesALoadedHostAlone() async {
        let fx = HostFakeEffects(facts: facts(plist: managed, installed: "2.0.0+bbb", port: true), hostArgs: hostManaged, loaded: true)
        _ = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(fx.calls.isEmpty)
    }
    @Test func checkoutHostIsNeverWritten() async {
        let fx = HostFakeEffects(facts: facts(plist: managed, installed: "2.0.0+aaa"), hostArgs: hostCheckout, loaded: false)
        _ = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(fx.calls.isEmpty)
    }
    @Test func hostFailureDoesNotFailTheDaemon() async {
        let fx = HostFakeEffects(facts: facts(), hostArgs: nil, loaded: false)
        fx.writeFails = true
        #expect(await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true) == .upToDate("2.0.0+bbb"))
        let fx2 = HostFakeEffects(facts: facts(), hostArgs: nil, loaded: false)
        fx2.bootstrapHostOK = false
        #expect(await DaemonInstallerRunner(effects: fx2).reconcile(userRequested: true) == .upToDate("2.0.0+bbb"))
    }
    @Test func failedDaemonTouchesNoHost() async {
        let fx = HostFakeEffects(facts: facts(), hostArgs: nil, loaded: false, daemonHealthy: false)
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        if case .failed = s {} else { Issue.record("expected failed") }
        #expect(fx.calls.isEmpty)
    }
}

@Suite struct LiveDaemonEffectsTests {
    private final class Launchctl: @unchecked Sendable {
        /// The daemon's state (the health check follows it); the host is tracked by label.
        var loaded = false
        var hostLoaded = false
        var log: [String] = []
        func run(_ exe: String, _ args: [String]) -> Int32 {
            log.append(args.joined(separator: " "))
            let isHost = args.last?.contains("com.squeak.host") == true
            switch args.first {
            case "print": return (isHost ? hostLoaded : loaded) ? 0 : 113
            case "bootstrap": if isHost { hostLoaded = true } else { loaded = true }; return 0
            case "bootout": if isHost { hostLoaded = false } else { loaded = false }; return 0
            default: return 0
            }
        }
    }

    @Test func installsUpdatesPrunesOnDisk() async throws {
        let tmp = FileManager.default.temporaryDirectory.appending(path: "sq-daemon-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bundle = tmp.appending(path: "App/daemon")
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        func makeBundle(_ v: String) throws { try v.write(to: bundle.appending(path: "VERSION"), atomically: true, encoding: .utf8) }
        let paths = LiveDaemonEffects.Paths(bundleDaemon: bundle, supportDir: tmp.appending(path: "support"),
                                            launchAgents: tmp.appending(path: "LaunchAgents"), logFile: tmp.appending(path: "log/squeak.log"))
        let ctl = Launchctl()
        let down = LiveDaemonEffects(paths: paths, uid: 501, runner: { ctl.run($0, $1) }, health: { ctl.loaded }, healthSeconds: 1, hostSessions: { _ in .down }, sleep: { _ in })
        let r2 = DaemonInstallerRunner(effects: down)
        try makeBundle("2.0.0+aaa")
        #expect(await r2.reconcile() == .notInstalled)  // no agent and no request: nothing
        #expect(!FileManager.default.fileExists(atPath: paths.plist.path))
        #expect(await r2.reconcile(userRequested: true) == .upToDate("2.0.0+aaa"))
        #expect(ctl.log.contains("bootstrap gui/501 \(paths.plist.path)"))
        #expect(down.currentVersionDirectory() == "2.0.0+aaa")
        let plist = try String(contentsOf: paths.plist, encoding: .utf8)
        #expect(plist.contains(paths.current.appending(path: "node").path))

        try makeBundle("2.0.0+bbb")
        #expect(await r2.reconcile() == .upToDate("2.0.0+bbb"))
        #expect(down.currentVersionDirectory() == "2.0.0+bbb")
        try makeBundle("2.0.0+ccc")
        #expect(await r2.reconcile() == .upToDate("2.0.0+ccc"))
        let dirs = try FileManager.default.contentsOfDirectory(atPath: paths.root.path).filter { !$0.hasPrefix(".") }.sorted()
        #expect(dirs == ["2.0.0+bbb", "2.0.0+ccc", "current"])
        #expect(ctl.log.contains("kickstart -k gui/501/com.squeak.daemon"))
        // The host came with the daemon: plist beside it, running `host` from `current`, loaded by launchd.
        let host = try String(contentsOf: paths.hostPlist, encoding: .utf8)
        #expect(host.contains("<string>host</string>") && host.contains(paths.current.appending(path: "dist/squeak/cli.js").path))
        #expect(ctl.log.contains("bootstrap gui/501 \(paths.hostPlist.path)"))
    }
}

@Suite struct DaemonDiagnosisTests {
    @Test func intelMac() {
        #expect(DaemonDiagnosis.reason(DaemonEvidence(appleSilicon: false, probeExit: nil)).contains("Intel"))
    }
    @Test func killedBySecurity() {
        #expect(DaemonDiagnosis.reason(DaemonEvidence(probeExit: nil, probeSignal: 9)).contains("allow Squeak"))
    }
    @Test func slowCheck() {
        #expect(DaemonDiagnosis.reason(DaemonEvidence(probeExit: nil, probeTimedOut: true)).contains("still checking"))
    }
    @Test func damagedNode() {
        #expect(DaemonDiagnosis.reason(DaemonEvidence(probeExit: 1)).contains("damaged"))
        let abi = "Error: The module was compiled against a different Node.js version using NODE_MODULE_VERSION 147"
        #expect(DaemonDiagnosis.reason(DaemonEvidence(log: abi)).contains("damaged"))
    }
    @Test func portTaken() {
        let log = "node:events:497\n      throw er;\nError: listen EADDRINUSE: address already in use 127.0.0.1:8477"
        #expect(DaemonDiagnosis.reason(DaemonEvidence(log: log)).contains("port (8477)"))
    }
    @Test func loggedErrorIsQuotedWithoutItsStamp() {
        let log = "[2026-11-03T11:56:18.911Z] INFO keeping the Mac awake\n[2026-11-03T11:56:19.000Z] ERROR squeak failed to start { boom }"
        #expect(DaemonDiagnosis.reason(DaemonEvidence(log: log)) == "The background service stopped while starting: squeak failed to start { boom }")
    }
    @Test func nothingWrittenIsSlowStart() {
        #expect(DaemonDiagnosis.reason(DaemonEvidence()) == DaemonDiagnosis.slowStart)
    }
    @Test func detailsCarryTheEvidence() {
        let d = DaemonDiagnosis.details(DaemonEvidence(probeExit: nil, probeSignal: 9, log: "a\nb"), version: "2.0.0+x")
        #expect(d.contains("2.0.0+x"))
        #expect(d.contains("killed by signal 9"))
        #expect(d.hasSuffix("a\nb"))
    }
}

@Suite struct DaemonProbeTests {
    @Test func probeReadsOutputExitAndTimeout() async {
        let ok = await LiveDaemonEffects.capture("/bin/echo", ["v22"], timeout: 5)
        #expect(ok.exit == 0 && ok.output == "v22\n" && !ok.timedOut)
        let slow = await LiveDaemonEffects.capture("/bin/sleep", ["5"], timeout: 0.3)
        #expect(slow.timedOut && slow.signal == nil)
        let missing = await LiveDaemonEffects.capture("/nonexistent/node", ["-v"], timeout: 1)
        #expect(missing.exit == nil && missing.signal == nil && !missing.timedOut)
    }
}
