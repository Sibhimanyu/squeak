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
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.0.0+bbb")) == .nothing(.upToDate("2.0.0+bbb")))
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: "2.1.0+zzz")) == .nothing(.upToDate("2.1.0+zzz")))
        #expect(DaemonInstaller.plan(facts(plist: managed, installed: nil)) == .update(from: nil))
        #expect(DaemonInstaller.plan(facts(plist: ["/Applications/Squeak.app/Contents/Resources/daemon/node", "x"], installed: nil)) == .update(from: nil))
    }
    @Test func failedVersionIsNotRetriedUntilRepair() {
        let f = facts(plist: managed, installed: "2.0.0+aaa", failed: "2.0.0+bbb")
        if case .nothing(.failed) = DaemonInstaller.plan(f) {} else { Issue.record("expected failed") }
        var r = f; r.userRequested = true
        #expect(DaemonInstaller.plan(r) == .update(from: "2.0.0+aaa"))
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
        #expect(fx.calls == ["copy 2.0.0+bbb", "switch 2.0.0+bbb", "plist", "bootstrap", "health", "prune 2.0.0+bbb"])
    }
    @Test func failedFirstInstallLeavesNothingLooping() async {
        let fx = FakeEffects(facts: facts(), current: nil, healthy: [false])
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        if case .failed = s {} else { Issue.record("expected failed") }
        #expect(fx.calls.suffix(2) == ["bootout", "removePlist"] || fx.calls.contains("removePlist"))
        #expect(fx.failed == "2.0.0+bbb")
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

@Suite struct LiveDaemonEffectsTests {
    private final class Launchctl: @unchecked Sendable {
        var loaded = false
        var log: [String] = []
        func run(_ exe: String, _ args: [String]) -> Int32 {
            log.append(args.joined(separator: " "))
            switch args.first {
            case "print": return loaded ? 0 : 113
            case "bootstrap": loaded = true; return 0
            case "bootout": loaded = false; return 0
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
        let down = LiveDaemonEffects(paths: paths, uid: 501, runner: { ctl.run($0, $1) }, health: { ctl.loaded }, healthSeconds: 1, sleep: { _ in })
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
    }
}
