import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RelaunchWatchdogTests {
    /// A temp app bundle with a version, stub `open` (touches a marker) and stub `pgrep` (exit code chosen).
    private struct Rig {
        let dir: URL
        var app: URL { dir.appendingPathComponent("Squeak.app") }
        var marker: URL { dir.appendingPathComponent("opened") }
        var token: URL { dir.appendingPathComponent("token") }
        var log: URL { dir.appendingPathComponent("watchdog.log") }

        init(version: String) throws {
            dir = FileManager.default.temporaryDirectory.appendingPathComponent("watchdog-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents"), withIntermediateDirectories: true)
            try setVersion(version)
        }

        func setVersion(_ version: String) throws {
            let plist = ["CFBundleShortVersionString": version] as NSDictionary
            plist.write(to: app.appendingPathComponent("Contents/Info.plist"), atomically: true)
        }

        func stub(_ name: String, body: String) throws -> String {
            let url = dir.appendingPathComponent(name)
            try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            return url.path
        }

        /// Runs the script for a pid that is already gone; returns whether `open` was called.
        func run(oldVersion: String, appRunning: Bool, limit: Int = 2, grace: Int = 0, armed: Bool = true, pid: Int32 = 999_999, waitForQuit: Int = 300) throws -> Bool {
            if armed { FileManager.default.createFile(atPath: token.path, contents: Data()) }
            let open = try stub("open-stub", body: "echo opened >> '\(marker.path)'")
            let pgrep = try stub("pgrep-stub", body: appRunning ? "exit 0" : "exit 1")
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = RelaunchWatchdog.arguments(pid: pid, appPath: app.path, version: oldVersion, limit: limit, grace: grace,
                                                           token: token.path, log: log.path, waitForQuit: waitForQuit)
            process.environment = ["SQUEAK_OPEN": open, "SQUEAK_PGREP": pgrep, "SQUEAK_RETRY_DELAY": "0", "PATH": "/usr/bin:/bin"]
            try process.run()
            process.waitUntilExit()
            return FileManager.default.fileExists(atPath: marker.path)
        }

        var opens: Int { ((try? String(contentsOf: marker, encoding: .utf8)) ?? "").split(separator: "\n").count }
        var logText: String { (try? String(contentsOf: log, encoding: .utf8)) ?? "" }
    }

    @Test func reopensAfterTheInstallChangedTheVersionAndNothingReopenedIt() throws {
        let rig = try Rig(version: "2.12.1")
        #expect(try rig.run(oldVersion: "2.11.11", appRunning: false))
    }

    @Test func leavesItAloneWhenSparkleAlreadyReopenedTheApp() throws {
        let rig = try Rig(version: "2.12.1")
        #expect(try !rig.run(oldVersion: "2.11.11", appRunning: true))
    }

    @Test func reopensTheOldAppWhenTheInstallNeverHappened() throws {
        let rig = try Rig(version: "2.11.11")
        // Same version for the whole limit: the install failed, so the app still comes back.
        #expect(try rig.run(oldVersion: "2.11.11", appRunning: false, limit: 2))
    }

    @Test func doesNotReopenAnAppThatIsRunningEvenWhenTheInstallFailed() throws {
        let rig = try Rig(version: "2.11.11")
        #expect(try !rig.run(oldVersion: "2.11.11", appRunning: true, limit: 2))
    }

    @Test func passesEveryValueAsAnArgumentNeverInsideTheScript() {
        let args = RelaunchWatchdog.arguments(pid: 42, appPath: "/Applications/My App's \"Squeak\".app", version: "2.12.1", token: "/tmp/t")
        #expect(args.first == "-c")
        #expect(!args[1].contains("My App"))
        #expect(args.contains("/Applications/My App's \"Squeak\".app"))
        #expect(args.suffix(8) == ["42", "/Applications/My App's \"Squeak\".app", "2.12.1", "90", "4", "/tmp/t", "", "300"])
    }

    @Test func aDisarmedAttemptNeverReopensEvenWhenTheAppIsGone() throws {
        // The install failed, the app kept running and the attempt was disarmed; the person quit later.
        let rig = try Rig(version: "2.11.11")
        #expect(try !rig.run(oldVersion: "2.11.11", appRunning: false, armed: false))
        #expect(rig.logText.contains("disarmed"))
    }

    @Test func aDisarmedAttemptAfterTheVersionChangedDoesNotReopenEither() throws {
        let rig = try Rig(version: "2.12.1")
        #expect(try !rig.run(oldVersion: "2.11.11", appRunning: false, armed: false))
    }

    @Test func opensASecondTimeWhenTheFirstOpenDidNotStartTheApp() throws {
        let rig = try Rig(version: "2.12.1")
        #expect(try rig.run(oldVersion: "2.11.11", appRunning: false))
        #expect(rig.opens == 2)
    }

    @Test func opensOnceWhenTheAppIsRunningAfterTheFirstOpen() throws {
        // Stub pgrep: not running before the first open, running after it.
        let rig = try Rig(version: "2.12.1")
        FileManager.default.createFile(atPath: rig.token.path, contents: Data())
        let open = try rig.stub("open-stub", body: "echo opened >> '\(rig.marker.path)'")
        let pgrep = try rig.stub("pgrep-stub", body: "[ -e '\(rig.marker.path)' ]")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = RelaunchWatchdog.arguments(pid: 999_999, appPath: rig.app.path, version: "2.11.11", limit: 2, grace: 0, token: rig.token.path, log: rig.log.path)
        process.environment = ["SQUEAK_OPEN": open, "SQUEAK_PGREP": pgrep, "SQUEAK_RETRY_DELAY": "0", "PATH": "/usr/bin:/bin"]
        try process.run(); process.waitUntilExit()
        #expect(rig.opens == 1)
    }

    @Test func writesWhatItDidToTheLog() throws {
        let rig = try Rig(version: "2.12.1")
        _ = try rig.run(oldVersion: "2.11.11", appRunning: false)
        #expect(rig.logText.contains("watchdog: armed for pid"))
        #expect(rig.logText.contains("installed version is 2.12.1"))
        #expect(rig.logText.contains("opening Squeak"))
    }

    @Test func givesUpWaitingWhenTheAppNeverQuits() throws {
        // A live pid (this test process) and a 1 s wait: the attempt was abandoned, nothing is opened.
        let rig = try Rig(version: "2.11.11")
        #expect(try !rig.run(oldVersion: "2.11.11", appRunning: false, pid: ProcessInfo.processInfo.processIdentifier, waitForQuit: 1))
        #expect(rig.logText.contains("never quit"))
    }

    @Test func armingTwiceKeepsOnlyTheLatestAttemptArmed() {
        let log = UpdateLog(url: FileManager.default.temporaryDirectory.appendingPathComponent("wd-\(UUID().uuidString).log"))
        defer { RelaunchWatchdog.disarm(log: nil) }
        // A live pid that is not this app's real bundle: the script would only wait, and is disarmed below.
        #expect(RelaunchWatchdog.arm(pid: ProcessInfo.processInfo.processIdentifier, appPath: "/nonexistent/Squeak.app", version: "9.9.9", log: log))
        #expect(RelaunchWatchdog.isArmed)
        #expect(RelaunchWatchdog.arm(pid: ProcessInfo.processInfo.processIdentifier, appPath: "/nonexistent/Squeak.app", version: "9.9.9", log: log))
        #expect(RelaunchWatchdog.isArmed)
        RelaunchWatchdog.disarm(log: nil)
        #expect(!RelaunchWatchdog.isArmed)
        // Arming again after a disarm works: it is per attempt, not once per process.
        #expect(RelaunchWatchdog.arm(pid: ProcessInfo.processInfo.processIdentifier, appPath: "/nonexistent/Squeak.app", version: "9.9.9", log: log))
        #expect(RelaunchWatchdog.isArmed)
    }

    @Test func refusesToArmWithoutAVersion() {
        let log = UpdateLog(url: FileManager.default.temporaryDirectory.appendingPathComponent("wd-\(UUID().uuidString).log"))
        #expect(!RelaunchWatchdog.arm(pid: 1, appPath: "/x/Squeak.app", version: "", log: log))
    }
}
