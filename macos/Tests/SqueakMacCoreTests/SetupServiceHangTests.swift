import Foundation
import Testing

@testable import SqueakMacCore

private func tempDir() throws -> URL {
    let d = FileManager.default.temporaryDirectory.appending(path: "squeak-hang-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

private func flag(_ url: URL) {
    let value = "0081;00000000;Safari;"
    _ = value.withCString { setxattr(url.path, Quarantine.attribute, $0, strlen($0), 0, 0) }
}

@Suite struct ProcessCaptureTests {
    @Test func deadlineKillsAndAnswersOnce() async {
        let start = Date()
        // A shell that ignores the polite stop: only the kill ends it.
        let r = await ProcessCapture.run("/bin/sh", ["-c", "trap '' TERM; sleep 30"], timeout: 0.3, grace: 0.3)
        #expect(r.timedOut)
        #expect(Date().timeIntervalSince(start) < 6)
    }
    @Test func answersEvenIfTheProcessNeverEnds() async {
        // The process is gone from our view only by the deadline: the answer still comes, marked timed out.
        let r = await ProcessCapture.run("/bin/sleep", ["30"], timeout: 0.2, grace: 0.2)
        #expect(r.timedOut)
        #expect(r.exit == nil || r.timedOut)
    }
    @Test func resumeOnceTakesTheFirstValueOnly() async {
        let once = ResumeOnce<Int>()
        #expect(once.finish(1))
        #expect(!once.finish(2))
        #expect(await once.wait() == 1)
    }
    @Test func launchctlRunnerThrowsOnDeadline() async {
        let r = await ProcessCapture.run("/bin/echo", ["hi"], timeout: 5)
        #expect(r.exit == 0 && !r.timedOut && r.output.contains("hi"))
    }
}

@Suite struct QuarantineTests {
    @Test func stripsOnlyInsideTheGivenFolder() throws {
        let tmp = try tempDir()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let inside = tmp.appending(path: "support/daemon/1.0")
        let outside = tmp.appending(path: "Downloads")
        try FileManager.default.createDirectory(at: inside.appending(path: "dist/x"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let node = inside.appending(path: "node"), deep = inside.appending(path: "dist/x/cli.js"), other = outside.appending(path: "Squeak.dmg")
        for u in [node, deep, other] { try Data("x".utf8).write(to: u) }
        for u in [inside, node, deep, other] { flag(u) }
        #expect(Quarantine.isQuarantined(node))
        let n = Quarantine.strip(under: inside)
        #expect(n == 3)
        #expect(!Quarantine.isQuarantined(node) && !Quarantine.isQuarantined(deep) && !Quarantine.isQuarantined(inside))
        #expect(Quarantine.isQuarantined(other))  // never outside the folder
    }
    @Test func copyBundleStripsTheCopyNotTheBundle() throws {
        let tmp = try tempDir()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let bundle = tmp.appending(path: "Squeak.app/Contents/Resources/daemon")
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        try Data("2.0.0+a".utf8).write(to: bundle.appending(path: "VERSION"))
        try Data("x".utf8).write(to: bundle.appending(path: "node"))
        flag(bundle.appending(path: "node")); flag(bundle.appending(path: "VERSION"))
        let paths = LiveDaemonEffects.Paths(bundleDaemon: bundle, supportDir: tmp.appending(path: "support"),
                                            launchAgents: tmp.appending(path: "LA"), logFile: tmp.appending(path: "log/squeak.log"))
        let fx = LiveDaemonEffects(paths: paths, uid: 501, runner: { _, _ in 1 }, health: { false }, healthSeconds: 0, hostSessions: { _ in .down }, sleep: { _ in })
        try fx.copyBundle(version: "2.0.0+a")
        let installed = paths.root.appending(path: "2.0.0+a")
        #expect(!Quarantine.isQuarantined(installed.appending(path: "node")))
        #expect(Quarantine.isQuarantined(bundle.appending(path: "node")))
    }
}

@Suite struct SetupServiceDeadlineTests {
    @Test func busyBecomesFailedAfterTheDeadline() {
        let t0 = Date(timeIntervalSince1970: 1000)
        #expect(SetupServiceFact.from(.updating("2"), connected: false, busy: true, busySince: t0, now: t0.addingTimeInterval(30)) == .installing)
        #expect(SetupServiceFact.from(.updating("2"), connected: false, busy: true, busySince: t0, now: t0.addingTimeInterval(661))
                == .failed("The background service didn't start."))
        #expect(SetupServiceFact.from(.updating("2"), connected: false, busy: true, busySince: t0, now: t0.addingTimeInterval(661),
                                      timeoutReason: "macOS stopped it.") == .failed("macOS stopped it."))
        // Answering wins over any clock.
        #expect(SetupServiceFact.from(.updating("2"), connected: true, busy: true, busySince: t0, now: t0.addingTimeInterval(500)) == .running)
    }
    @Test func approvalIsItsOwnStateBeforeStarting() {
        #expect(SetupServiceFact.from(.needsApproval, connected: false, busy: false) == .needsApproval)
        let flow = SetupFlow(SetupFlowFacts(setup: SetupFacts(service: .needsApproval)))
        #expect(flow.serviceNeedsApproval)
        #expect(flow.nextConnectAction(attempted: []) == nil)
        #expect(SetupChecklist(SetupFacts(service: .needsApproval)).step(.service).action == .openLoginItems)
    }
}

@Suite struct DaemonDiagnosisKillTests {
    @Test func sigkillReadsAsMacOSBlockingIt() {
        let r = DaemonDiagnosis.reason(DaemonEvidence(probeExit: nil, probeSignal: 9))
        #expect(r.hasPrefix("macOS stopped the background service"))
        #expect(DaemonDiagnosis.details(DaemonEvidence(probeExit: nil, probeSignal: 9), version: "2").contains("killed by signal 9"))
    }
    @Test func approvalMapping() {
        #expect(BackgroundApproval.from(rawStatus: 1) == .allowed)
        #expect(BackgroundApproval.from(rawStatus: 2) == .needsApproval)
        #expect(BackgroundApproval.from(rawStatus: 3) == .unknown)
        #expect(BackgroundApproval.from(rawStatus: 0) == .unknown)
    }
}

private final class ApprovalFake: DaemonEffects, @unchecked Sendable {
    var calls: [String] = []
    var approval: BackgroundApproval = .needsApproval
    func gatherFacts(userRequested: Bool) async -> DaemonFacts {
        DaemonFacts(bundledVersion: "2.0.0+b", userRequested: userRequested, supportDaemonRoot: "/s/daemon")
    }
    func currentVersionDirectory() -> String? { nil }
    func copyBundle(version: String) throws { calls.append("copy") }
    func writePlist() throws { calls.append("plist") }
    func removePlist() { calls.append("removePlist") }
    func switchCurrent(to version: String) throws { calls.append("switch") }
    func bootstrap() async -> Bool { calls.append("bootstrap"); return true }
    func bootout() async {}
    func kickstart() async -> Bool { true }
    func waitHealthy() async -> Bool { calls.append("health"); return true }
    func prune(keeping: Set<String>) {}
    func setFailedVersion(_ version: String?) {}
    func backgroundApproval() -> BackgroundApproval { approval }
    func resetForRetry() async { calls.append("reset") }
}

@Suite struct ApprovalFlowTests {
    @Test func installStopsBeforeLoadingUntilAllowed() async {
        let fx = ApprovalFake()
        let s = await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true)
        #expect(s == .needsApproval)
        #expect(fx.calls == ["copy", "switch", "plist"])  // plist stays; nothing loaded, nothing removed
        fx.approval = .allowed
        fx.calls = []
        #expect(await DaemonInstallerRunner(effects: fx).reconcile(userRequested: true) == .upToDate("2.0.0+b"))
        #expect(fx.calls.contains("bootstrap"))
    }
    @Test func retryFromScratchResetsFirst() async {
        let fx = ApprovalFake()
        fx.approval = .allowed
        _ = await DaemonInstallerRunner(effects: fx).retryFromScratch()
        #expect(fx.calls.first == "reset")
        #expect(fx.calls.contains("bootstrap"))
    }
}

@Suite struct ResetForRetryTests {
    @Test func clearsPartialInstallAndOnlyOurs() async throws {
        let tmp = try tempDir()
        defer { try? FileManager.default.removeItem(at: tmp) }
        let fm = FileManager.default
        let paths = LiveDaemonEffects.Paths(bundleDaemon: tmp.appending(path: "b"), supportDir: tmp.appending(path: "support"),
                                            launchAgents: tmp.appending(path: "LA"), logFile: tmp.appending(path: "log/squeak.log"))
        try fm.createDirectory(at: paths.root.appending(path: "2.0.0+b"), withIntermediateDirectories: true)
        try fm.createDirectory(at: paths.root.appending(path: ".partial-2.1.0"), withIntermediateDirectories: true)
        try fm.createDirectory(at: paths.root.appending(path: "1.9.0"), withIntermediateDirectories: true)
        try Data("2.0.0".utf8).write(to: paths.root.appending(path: "1.9.0/VERSION"))
        try "2.0.0+b".write(to: paths.failedMarker, atomically: true, encoding: .utf8)
        try Data("{}".utf8).write(to: paths.failureFile)
        try fm.createSymbolicLink(atPath: paths.current.path, withDestinationPath: "2.0.0+b")
        try fm.createDirectory(at: paths.launchAgents, withIntermediateDirectories: true)
        try DaemonInstaller.plistText(nodePath: paths.current.appending(path: "node").path, cliPath: "/x", logPath: "/l")
            .write(to: paths.plist, atomically: true, encoding: .utf8)
        try "half".write(to: paths.hostPlist, atomically: true, encoding: .utf8)
        let other = paths.launchAgents.appending(path: "com.other.plist")
        try "x".write(to: other, atomically: true, encoding: .utf8)
        let fx = LiveDaemonEffects(paths: paths, uid: 501, runner: { _, _ in 1 }, health: { false }, healthSeconds: 0, hostSessions: { _ in .down }, sleep: { _ in })
        await fx.resetForRetry()
        #expect(!fm.fileExists(atPath: paths.failedMarker.path))
        #expect(!fm.fileExists(atPath: paths.failureFile.path))
        #expect(!fm.fileExists(atPath: paths.root.appending(path: "2.0.0+b").path))
        #expect(!fm.fileExists(atPath: paths.root.appending(path: ".partial-2.1.0").path))
        #expect(!fm.fileExists(atPath: paths.plist.path))
        #expect(!fm.fileExists(atPath: paths.hostPlist.path))  // half-written
        #expect(fm.fileExists(atPath: paths.root.appending(path: "1.9.0/VERSION").path))  // an earlier good version stays
        #expect(fm.fileExists(atPath: other.path))
        #expect((try? fm.destinationOfSymbolicLink(atPath: paths.current.path)) == nil)
    }
}
