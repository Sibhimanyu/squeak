import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Fan control rule")
struct FanRuleTests {
    // What src/fleet/heat.ts `fansSudoersRule` writes.
    let rule = """
        # Squeak: fans to full while a Mac kept awake runs hot, and back to the system's control.
        # Exactly these two commands of a root-owned helper. Remove this file to take it back.
        sibhi ALL=(root) NOPASSWD: /Library/PrivilegedHelperTools/com.squeak.fans max, /Library/PrivilegedHelperTools/com.squeak.fans auto

        """

    /// An executable file standing in for the bundled helper.
    func helper() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-fans-test-\(UUID().uuidString)")
        try Data("#!/bin/sh\n".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    @Test func acceptsOnlyTheDaemonsRuleForThisUser() {
        #expect(FanRule.isExpected(rule, user: "sibhi"))
        #expect(!FanRule.isExpected(rule, user: "someone-else"))
        #expect(!FanRule.isExpected(rule + "sibhi ALL=(root) NOPASSWD: ALL\n", user: "sibhi"))
        #expect(!FanRule.isExpected(rule.replacingOccurrences(of: "com.squeak.fans auto", with: "com.squeak.fans *"), user: "sibhi"))
        #expect(!FanRule.isExpected(rule.replacingOccurrences(of: "sibhi", with: "ALL"), user: "ALL"))
    }

    @Test func checksTheSignatureAndVisudoThenAsksOnceForBoth() async throws {
        let calls = Calls()
        let file = try helper()
        let outcome = await FanRule.install(rule, user: "sibhi", helper: file, app: URL(fileURLWithPath: "/Applications/Squeak.app")) { exe, args in
            await calls.add(exe)
            if exe == "/usr/bin/codesign", args.first == "-dv" { return .init(status: 0, stderr: "Identifier=x\nTeamIdentifier=R5H6Z6H9Y7\n") }
            if exe == "/usr/bin/osascript" {
                let text = args.joined(separator: " ")
                #expect(text.contains("/etc/sudoers.d/squeak-fans"))
                #expect(text.contains("-o root -g wheel -m 0755"))
                #expect(args.last == file.path)
            }
            return .init(status: 0, stderr: "")
        }
        #expect(outcome == .installed)
        #expect(await calls.list == ["/usr/bin/codesign", "/usr/bin/codesign", "/usr/bin/codesign", "/usr/sbin/visudo", "/usr/bin/osascript"])
    }

    @Test func aHelperSignedBySomeoneElseNeverReachesThePrompt() async throws {
        let calls = Calls()
        let file = try helper()
        let outcome = await FanRule.install(rule, user: "sibhi", helper: file, app: URL(fileURLWithPath: "/Applications/Squeak.app")) { exe, args in
            await calls.add(exe)
            if exe == "/usr/bin/codesign", args.first == "-dv" {
                return .init(status: 0, stderr: args.last == file.path ? "TeamIdentifier=OTHER\n" : "TeamIdentifier=R5H6Z6H9Y7\n")
            }
            return .init(status: 0, stderr: "")
        }
        #expect(outcome == .failed("The fan helper isn't signed by the same developer as Squeak, so nothing was installed."))
        #expect(!(await calls.list).contains("/usr/bin/osascript"))
    }

    @Test func anAdHocHelperIsRefused() async throws {
        let file = try helper()
        let outcome = await FanRule.install(rule, user: "sibhi", helper: file, app: URL(fileURLWithPath: "/x")) { exe, args in
            exe == "/usr/bin/codesign" && args.first == "-dv" ? .init(status: 0, stderr: "TeamIdentifier=not set\n") : .init(status: 0, stderr: "")
        }
        #expect(outcome != .installed)
    }

    @Test func noBundledHelperSaysToUpdate() async {
        let outcome = await FanRule.install(rule, user: "sibhi", helper: URL(fileURLWithPath: "/nonexistent/squeak-fans")) { _, _ in
            .init(status: 0, stderr: "")
        }
        #expect(outcome == .failed("This copy of Squeak has no fan helper. Update Squeak first."))
    }
}

private actor Calls {
    var list: [String] = []
    func add(_ s: String) { list.append(s) }
}
