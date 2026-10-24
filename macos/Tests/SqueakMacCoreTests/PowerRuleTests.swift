import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Energy mode rule")
struct PowerRuleTests {
    // What src/fleet/power-mode.ts `powerSudoersRule` writes.
    let rule = """
        # Squeak: set the Mac's energy mode (Automatic, Low Power, High Power) from your iPhone.
        # Exactly these three commands, without a password. Remove this file to take it back.
        sibhi ALL=(root) NOPASSWD: /usr/bin/pmset -a powermode 0, /usr/bin/pmset -a powermode 1, /usr/bin/pmset -a powermode 2

        """

    @Test func acceptsOnlyTheDaemonsRuleForThisUser() {
        #expect(PowerRule.isExpected(rule, user: "sibhi"))
        #expect(!PowerRule.isExpected(rule, user: "someone-else"))
        #expect(!PowerRule.isExpected(rule.replacingOccurrences(of: "sibhi", with: "ALL"), user: "ALL"))
        #expect(!PowerRule.isExpected(rule + "sibhi ALL=(root) NOPASSWD: ALL\n", user: "sibhi"))
        #expect(!PowerRule.isExpected(rule.replacingOccurrences(of: "powermode 2", with: "powermode 3"), user: "sibhi"))
        #expect(!PowerRule.isExpected(rule.replacingOccurrences(of: "/usr/bin/pmset -a powermode 2", with: "/usr/bin/pmset"), user: "sibhi"))
    }

    @Test func theLidRuleIsStillExactlyItsFourCommands() {
        // The power rule is a file of its own: an app that does not know it keeps installing the lid rule unchanged.
        #expect(LidRule.commands.count == 4)
        #expect(!LidRule.commands.contains { $0.contains("powermode") && !$0.contains("lowpowermode") })
        #expect(PowerRule.path == "/etc/sudoers.d/squeak-power")
    }

    @Test func checksWithVisudoThenAsksForThePassword() async {
        let calls = Calls()
        let outcome = await PowerRule.install(rule, user: "sibhi") { exe, args in
            await calls.add(exe)
            if exe == "/usr/bin/osascript" { #expect(args.joined(separator: " ").contains("/etc/sudoers.d/squeak-power")) }
            return .init(status: 0, stderr: "")
        }
        #expect(outcome == .installed)
        #expect(await calls.list == ["/usr/sbin/visudo", "/usr/bin/osascript"])
    }

    @Test func aRuleVisudoRejectsOrAnUnexpectedOneNeverReachesThePrompt() async {
        let calls = Calls()
        let bad = await PowerRule.install(rule, user: "sibhi") { exe, _ in
            await calls.add(exe); return .init(status: 1, stderr: "syntax error")
        }
        #expect(bad == .failed("The rule didn't pass visudo: syntax error"))
        #expect(await calls.list == ["/usr/sbin/visudo"])
        let odd = Calls()
        let refused = await PowerRule.install("sibhi ALL=(ALL) NOPASSWD: ALL\n", user: "sibhi") { exe, _ in
            await odd.add(exe); return .init(status: 0, stderr: "")
        }
        #expect(refused != .installed)
        #expect(await odd.list.isEmpty)
    }

    @Test func dismissingThePromptIsACancel() async {
        let outcome = await PowerRule.install(rule, user: "sibhi") { exe, _ in
            exe == "/usr/bin/osascript" ? .init(status: 1, stderr: "User cancelled. (-128)") : .init(status: 0, stderr: "")
        }
        #expect(outcome == .cancelled)
    }

    @Test func stateCarriesTheModeAndWhetherItIsSetUp() throws {
        let json = #"{"active":[],"power":{"mode":"high","choice":"high","available":["auto","low","high"],"ready":false}}"#
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
        #expect(state.power == DaemonPower(mode: "high", choice: "high", available: ["auto", "low", "high"], ready: false))
        #expect(DaemonPower.title("high") == "High Power")
        let old = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"active":[]}"#.utf8))
        #expect(old.power == nil)
    }
}

private actor Calls {
    var list: [String] = []
    func add(_ s: String) { list.append(s) }
}
