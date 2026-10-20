import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Lid-closed rule")
struct LidRuleTests {
    // What src/fleet/lid-sleep.ts `sudoersRule` writes.
    let rule = """
        # Squeak: keep the Mac awake with the lid closed, and Low Power Mode while it is.
        # Exactly these four commands, without a password. Remove this file to take it back.
        sibhi ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -b lowpowermode 1, /usr/bin/pmset -b lowpowermode 0

        """

    @Test func acceptsOnlyTheDaemonsRuleForThisUser() {
        #expect(LidRule.isExpected(rule, user: "sibhi"))
        #expect(!LidRule.isExpected(rule, user: "someone-else"))
        #expect(!LidRule.isExpected(rule.replacingOccurrences(of: "sibhi", with: "ALL"), user: "ALL"))
        #expect(!LidRule.isExpected(rule + "sibhi ALL=(root) NOPASSWD: ALL\n", user: "sibhi"))
        #expect(!LidRule.isExpected(rule.replacingOccurrences(of: "/usr/bin/pmset -b lowpowermode 0", with: "/bin/sh"), user: "sibhi"))
    }

    @Test func checksWithVisudoThenAsksForThePassword() async {
        let calls = Calls()
        let outcome = await LidRule.install(rule, user: "sibhi") { exe, args in
            await calls.add(exe)
            if exe == "/usr/bin/osascript" { #expect(args.joined(separator: " ").contains("/etc/sudoers.d/squeak")) }
            return .init(status: 0, stderr: "")
        }
        #expect(outcome == .installed)
        #expect(await calls.list == ["/usr/sbin/visudo", "/usr/bin/osascript"])
    }

    @Test func aRuleVisudoRejectsNeverReachesThePrompt() async {
        let calls = Calls()
        let outcome = await LidRule.install(rule, user: "sibhi") { exe, _ in
            await calls.add(exe)
            return .init(status: 1, stderr: "syntax error")
        }
        #expect(outcome == .failed("The rule didn't pass visudo: syntax error"))
        #expect(await calls.list == ["/usr/sbin/visudo"])
    }

    @Test func dismissingThePromptIsACancelNotAFailure() async {
        let outcome = await LidRule.install(rule, user: "sibhi") { exe, _ in
            exe == "/usr/bin/osascript" ? .init(status: 1, stderr: "execution error: User cancelled. (-128)") : .init(status: 0, stderr: "")
        }
        #expect(outcome == .cancelled)
    }

    @Test func anUnexpectedRuleIsRefusedWithoutRunningAnything() async {
        let calls = Calls()
        let outcome = await LidRule.install("sibhi ALL=(ALL) NOPASSWD: ALL\n", user: "sibhi") { exe, _ in
            await calls.add(exe); return .init(status: 0, stderr: "")
        }
        #expect(outcome != .installed)
        #expect(await calls.list.isEmpty)
    }

    @Test func stateSaysWhetherLidClosedIsSetUp() throws {
        let ready = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"active":[],"keepAwake":false,"awakeLidReady":true}"#.utf8))
        #expect(ready.awakeLidReady)
        let old = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"active":[]}"#.utf8))
        #expect(!old.awakeLidReady)
    }
}

private actor Calls {
    var list: [String] = []
    func add(_ s: String) { list.append(s) }
}
