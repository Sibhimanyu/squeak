import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RelaunchWatchdogTests {
    /// A temp app bundle with a version, stub `open` (touches a marker) and stub `pgrep` (exit code chosen).
    private struct Rig {
        let dir: URL
        var app: URL { dir.appendingPathComponent("Squeak.app") }
        var marker: URL { dir.appendingPathComponent("opened") }

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
        func run(oldVersion: String, appRunning: Bool, limit: Int = 2, grace: Int = 0) throws -> Bool {
            let open = try stub("open-stub", body: "touch '\(marker.path)'")
            let pgrep = try stub("pgrep-stub", body: appRunning ? "exit 0" : "exit 1")
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = RelaunchWatchdog.arguments(pid: 999_999, appPath: app.path, version: oldVersion, limit: limit, grace: grace)
            process.environment = ["SQUEAK_OPEN": open, "SQUEAK_PGREP": pgrep, "PATH": "/usr/bin:/bin"]
            try process.run()
            process.waitUntilExit()
            return FileManager.default.fileExists(atPath: marker.path)
        }
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
        let args = RelaunchWatchdog.arguments(pid: 42, appPath: "/Applications/My App's \"Squeak\".app", version: "2.12.1")
        #expect(args.first == "-c")
        #expect(!args[1].contains("My App"))
        #expect(args.contains("/Applications/My App's \"Squeak\".app"))
        #expect(args.suffix(5) == ["42", "/Applications/My App's \"Squeak\".app", "2.12.1", "90", "4"])
    }
}
