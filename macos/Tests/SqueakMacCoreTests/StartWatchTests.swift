import Foundation
import Testing

@testable import SqueakMacCore

private func sample(_ t: Double, phase: String? = nil, at: String? = nil, cpu: Double? = nil, alive: Bool = true, loaded: Bool = true,
                    runs: Int? = 1, exit: Int? = nil, healthy: Bool = false, error: String? = nil) -> StartSample {
    StartSample(elapsed: t, healthy: healthy, phase: phase, phaseAt: at, error: error, loaded: loaded, pidAlive: alive,
                cpuSeconds: cpu, runs: runs, lastExit: exit)
}

@Suite struct StartWatchTests {
    @Test func slowFirstStartKeepsWaitingForTenMinutesWhileAdvancing() {
        var w = StartWatch(upgrade: false)
        var t = 0.0
        var cpu = 0.0
        while t < 590 {
            cpu += 1  // security software scanning: the process is busy
            let d = w.observe(sample(t, cpu: cpu))
            guard case .wait = d else { Issue.record("gave up at \(t): \(d)"); return }
            t += 10
        }
        #expect(w.observe(sample(600, cpu: cpu + 1)) == .fail(.timedOut))
    }
    @Test func phaseAdvanceCountsAsProgressWithoutCPU() {
        var w = StartWatch(upgrade: false)
        #expect(w.observe(sample(0, phase: "loading", at: "1")) == .wait("Loading…"))
        #expect(w.observe(sample(170, phase: "loading", at: "1")) == .wait("Loading…"))
        #expect(w.observe(sample(200, phase: "database", at: "2")) == .wait("Opening its database…"))
        #expect(w.observe(sample(370, phase: "database", at: "2")) == .wait("Opening its database…"))
        #expect(w.observe(sample(400, phase: "fleet", at: "3")) == .wait("Watching your sessions…"))
        #expect(w.observe(sample(410, phase: "listening", at: "4")) == .wait("Almost ready…"))
        #expect(w.observe(sample(420, healthy: true)) == .success)
    }
    @Test func aliveButSilentIsStuckEventually() {
        var w = StartWatch(upgrade: false)
        _ = w.observe(sample(0, phase: "loading", at: "1", cpu: 1))
        #expect(w.observe(sample(100, phase: "loading", at: "1", cpu: 1)) != .fail(.stalled))
        #expect(w.observe(sample(190, phase: "loading", at: "1", cpu: 1)) == .fail(.stalled))
    }
    @Test func failedPhaseFailsAtOnceWithItsError() {
        var w = StartWatch(upgrade: false)
        #expect(w.observe(sample(4, phase: "failed", error: "EADDRINUSE")) == .fail(.reported("EADDRINUSE")))
    }
    @Test func crashLoopFails() {
        var w = StartWatch(upgrade: false)
        _ = w.observe(sample(0, runs: 1))
        #expect(w.observe(sample(12, alive: false, runs: 2, exit: 1)) != .fail(.crashLoop))
        #expect(w.observe(sample(24, runs: 3, exit: 1)) == .fail(.crashLoop))
        #expect(StartFailure.crashLoop.isDefinite)
    }
    @Test func nothingRunningAfterBootstrapFails() {
        var w = StartWatch(upgrade: false)
        #expect(w.observe(sample(1, alive: false, loaded: false)) != .fail(.noProcess))  // launchd may lag a moment
        #expect(w.observe(sample(5, alive: false, loaded: false)) == .fail(.noProcess))
        var gone = StartWatch(upgrade: false)
        _ = gone.observe(sample(0, alive: false))
        #expect(gone.observe(sample(40, alive: false)) == .fail(.noProcess))
    }
    @Test func firstInstallTimeoutIsNeverARollbackAndIsNotDefinite() {
        var w = StartWatch(upgrade: false)
        let d = w.observe(sample(601, cpu: 5))
        #expect(d == .fail(.timedOut))
        #expect(!StartFailure.timedOut.isDefinite && !StartFailure.stalled.isDefinite)  // the service is left loaded
    }
    @Test func upgradeTimeoutRollsBack() {
        var w = StartWatch(upgrade: true)
        #expect(w.observe(sample(60, cpu: 1)) != .rollback(.timedOut))
        #expect(w.observe(sample(121, cpu: 2)) == .rollback(.timedOut))
        var f = StartWatch(upgrade: true)
        #expect(f.observe(sample(3, phase: "failed", error: "x")) == .rollback(.reported("x")))
    }
    @Test func healthWins() {
        var w = StartWatch(upgrade: false)
        #expect(w.observe(sample(700, phase: "failed", healthy: true)) == .success)
    }
}

/// A fake that looks at a scripted sequence of samples.
private final class WatchFake: DaemonEffects, @unchecked Sendable {
    var calls: [String] = []
    var samples: [StartSample]
    var starting = false
    let factsValue: DaemonFacts
    var recorded: DaemonFailure?
    init(facts: DaemonFacts, samples: [StartSample]) { factsValue = facts; self.samples = samples }
    func gatherFacts(userRequested: Bool) async -> DaemonFacts { var f = factsValue; f.userRequested = userRequested; return f }
    func currentVersionDirectory() -> String? { "2.0.0+aaa" }
    func copyBundle(version: String) throws {}
    func writePlist() throws { calls.append("plist") }
    func removePlist() { calls.append("removePlist") }
    func switchCurrent(to version: String) throws {}
    func bootstrap() async -> Bool { calls.append("bootstrap"); return true }
    func bootout() async { calls.append("bootout") }
    func kickstart() async -> Bool { calls.append("kickstart"); return true }
    func waitHealthy() async -> Bool { false }
    func prune(keeping: Set<String>) {}
    func setFailedVersion(_ version: String?) {}
    func recordFailure(_ failure: DaemonFailure?) { recorded = failure }
    func startSample(elapsed: Double) async -> StartSample? {
        var s = samples.isEmpty ? SqueakSampleLast : samples.removeFirst()
        s.elapsed = elapsed
        return s
    }
    func isStarting() async -> Bool { starting }
}
private let SqueakSampleLast = StartSample(elapsed: 0, cpuSeconds: nil)

@Suite struct StartRunnerTests {
    private let root = "/s/daemon"
    private func facts(plist: [String]? = nil, installed: String? = nil, bundled: String = "2.0.0+bbb") -> DaemonFacts {
        DaemonFacts(plistArguments: plist, installedVersion: installed, bundledVersion: bundled, supportDaemonRoot: root)
    }
    private var managed: [String] { ["\(root)/current/node", "\(root)/current/dist/squeak/cli.js", "start"] }

    @Test func slowFirstInstallThatFinishesSucceeds() async {
        var seq: [StartSample] = (0..<100).map { StartSample(elapsed: 0, phase: "loading", phaseAt: "\($0)") }
        seq.append(StartSample(elapsed: 0, healthy: true))
        let fx = WatchFake(facts: facts(), samples: seq)
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        #expect(s == .upToDate("2.0.0+bbb"))
    }
    @Test func firstInstallThatNeverAnswersKeepsItsPlistAndStaysLoaded() async {
        let seq = (0..<400).map { StartSample(elapsed: 0, phase: "database", phaseAt: "\($0)") }
        let fx = WatchFake(facts: facts(), samples: seq)
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        if case .failed(let why, nil) = s { #expect(why.contains("left running")) } else { Issue.record("expected failed") }
        #expect(!fx.calls.contains("removePlist") && !fx.calls.contains("bootout"))
    }
    @Test func failedPhaseStopsTheLoopButKeepsThePlist() async {
        let fx = WatchFake(facts: facts(), samples: [StartSample(elapsed: 0, phase: "failed", error: "boom")])
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        if case .failed(let why, _) = s { #expect(why.contains("boom")) } else { Issue.record("expected failed") }
        #expect(fx.calls.contains("bootout") && !fx.calls.contains("removePlist"))
    }
    @Test func reopenedAppResumesAStartInsteadOfKicking() async {
        let fx = WatchFake(facts: facts(plist: managed, installed: "2.0.0+bbb"),
                           samples: [StartSample(elapsed: 0, phase: "fleet", phaseAt: "1"), StartSample(elapsed: 0, healthy: true)])
        fx.starting = true
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        #expect(s == .upToDate("2.0.0+bbb"))
        #expect(!fx.calls.contains("kickstart") && !fx.calls.contains("bootstrap"))
    }
    @Test func repairStillKicks() async {
        let fx = WatchFake(facts: facts(plist: managed, installed: "2.0.0+bbb"), samples: [StartSample(elapsed: 0, healthy: true)])
        fx.starting = true
        _ = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        #expect(fx.calls.contains("kickstart"))
    }
    @Test func slowUpgradeRollsBack() async {
        let seq = (0..<100).map { StartSample(elapsed: 0, phase: "loading", phaseAt: "\($0)") }
        let fx = WatchFake(facts: facts(plist: managed, installed: "2.0.0+aaa"), samples: seq)
        let s = await DaemonInstallerRunner(effects: fx).reconcile()
        if case .failed(let why, _) = s { #expect(why.contains("rolled back") || why.contains("did not either")) } else { Issue.record("expected failed") }
    }
}

@Suite struct LaunchdParsingTests {
    @Test func readsPidRunsAndLastExit() {
        let text = """
        gui/501/com.squeak.daemon = {
            state = running
            runs = 3
            pid = 4242
            last exit code = 1
        }
        """
        let l = LiveDaemonEffects.parseLaunchd(text)
        #expect(l.pid == 4242 && l.runs == 3 && l.lastExit == 1 && l.state == "running")
        #expect(LiveDaemonEffects.parseLaunchd("last exit code = (never exited)").lastExit == nil)
    }
    @Test func cpuTime() {
        #expect(LiveDaemonEffects.parseCPUTime(" 1:02.50\n") == 62.5)
        #expect(LiveDaemonEffects.parseCPUTime("1:00:03") == 3603)
        #expect(LiveDaemonEffects.parseCPUTime("") == nil)
    }
}
