import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct UninstallRunnerTests {
    static let plan = #"{"event":"plan","dryRun":true,"keepData":false,"steps":[{"id":"conductor","title":"Hand Conductor back","detail":"Reset the relay","needsAdmin":false,"items":["relay"]},{"id":"admin","title":"Admin","detail":"sudoers","needsAdmin":true,"items":["/etc/sudoers.d/squeak"]}]}"#

    @Test func parsesPlan() {
        guard case .plan(let p)? = UninstallLine.parse(Self.plan) else { Issue.record("no plan"); return }
        #expect(p.dryRun && !p.keepData && p.steps.count == 2)
        #expect(p.steps[1].needsAdmin && p.steps[1].items == ["/etc/sudoers.d/squeak"])
    }

    @Test func ignoresUnknownAndBrokenLines() {
        #expect(UninstallLine.parse("hello") == nil)
        #expect(UninstallLine.parse(#"{"event":"mystery"}"#) == nil)
        #expect(UninstallLine.parse(#"{"event":"step","id":"x","status":"weird"}"#) == nil)
        #expect(UninstallLine.parse("") == nil)
    }

    @Test func failingAdminStepAndOkFalse() {
        let lines = [
            Self.plan,
            #"{"event":"step","id":"admin","status":"start"}"#,
            "noise",
            #"{"event":"step","id":"admin","status":"failed","note":"Administrator permission was cancelled."}"#,
            #"{"event":"done","ok":false,"restartConductor":false,"appToTrash":"/Applications/Squeak.app","offMac":[]}"#,
        ]
        let r = UninstallRunner.result(lines: lines, exitCode: 1)
        #expect(r.steps.count == 2 && r.steps[1].status == .failed)
        #expect(r.steps[1].note == "Administrator permission was cancelled.")
        #expect(r.done?.ok == false && !r.ok && r.failure == nil)
    }

    @Test func doneWithRestartAndOffMacLinks() {
        let line = #"{"event":"done","ok":true,"restartConductor":true,"appToTrash":"/Applications/Squeak.app","offMac":[{"title":"Telegram bot","detail":"Delete via BotFather","url":"https://t.me/BotFather"},{"title":"iPhone app","detail":"Delete it"}]}"#
        let r = UninstallRunner.result(lines: [line], exitCode: 0)
        #expect(r.ok && r.done?.restartConductor == true)
        #expect(r.done?.appToTrash == "/Applications/Squeak.app")
        #expect(r.done?.offMac[0].url == "https://t.me/BotFather" && r.done?.offMac[1].url == nil)
    }

    @Test func nonzeroExitWithoutDoneIsFailure() {
        let r = UninstallRunner.result(lines: ["garbage"], exitCode: 2)
        #expect(!r.ok && r.failure != nil && r.done == nil)
    }

    @Test func argumentsKeepData() {
        #expect(UninstallRunner.arguments(dryRun: true, keepData: false) == ["uninstall", "--json", "--dry-run"])
        #expect(UninstallRunner.arguments(dryRun: false, keepData: false) == ["uninstall", "--json", "--yes"])
        #expect(UninstallRunner.arguments(dryRun: false, keepData: true) == ["uninstall", "--json", "--yes", "--keep-data"])
    }

    @Test func locatesBundledThenInstalled() {
        let res = URL(fileURLWithPath: "/App/Contents/Resources"), sup = URL(fileURLWithPath: "/S")
        let bundled = UninstallRunner.locate(bundleResources: res, supportDirectory: sup) { _ in true }
        #expect(bundled?.node.path == "/App/Contents/Resources/daemon/node")
        #expect(bundled?.cli.path == "/App/Contents/Resources/daemon/dist/squeak/cli.js")
        let installed = UninstallRunner.locate(bundleResources: res, supportDirectory: sup) { $0.hasPrefix("/S/") }
        #expect(installed?.cli.path == "/S/daemon/current/dist/squeak/cli.js")
        #expect(UninstallRunner.locate(bundleResources: res, supportDirectory: sup) { _ in false } == nil)
    }

    @Test func cliNotFoundThrows() async {
        await #expect(throws: UninstallRunnerError.cliNotFound) {
            _ = try await UninstallRunner(cli: nil).run(dryRun: true, keepData: false)
        }
    }
}
