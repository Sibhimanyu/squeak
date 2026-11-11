import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct SetupFailureReportTests {
    func report(log: [String] = [], details: String = "Mac: Apple silicon") -> SetupFailureReport {
        SetupFailureReport(macOS: "26.0", arch: "arm64", appVersion: "2.23.1", step: "Start Squeak",
                           reason: "The background service didn't answer in time.", details: details,
                           launchctl: "state = not running, last exit code = 78", logTail: log, home: "/Users/someone")
    }

    @Test func redactsTokensEmailsAndHome() {
        let secret = "abcdEFGH1234abcdEFGH1234abcdEFGH1234"
        let r = report(log: [
            "opened /Users/someone/Library/Application Support/squeak/remote.json",
            "token: \(secret)",
            "mailed me@example.com via https://x.example/path?k=1",
        ])
        let text = r.reportText()
        #expect(!text.contains(secret))
        #expect(!text.contains("/Users/someone"))
        #expect(!text.contains("me@example.com"))
        #expect(!text.contains("https://"))
        #expect(text.contains("~/Library/Application"))
        #expect(r.logFacts.joined().contains("squeak.log:"))
        #expect(!r.logFacts.joined().contains(secret))
    }

    @Test func keepsOnlyTheNewestThirtyLogLines() {
        let lines = (1...80).map { "line \($0)" }
        let facts = report(log: lines).logFacts.filter { $0.hasPrefix("squeak.log:") }
        #expect(facts.count == 30)
        #expect(facts.last == "squeak.log: line 80")
    }

    @Test func truncatesLogBeforeDetailsAndStaysUnderLimit() {
        let lines = (1...30).map { "log line number \($0) " + String(repeating: "word ", count: 30) }
        let text = report(log: lines).reportText(maxBytes: 1200)
        #expect(text.utf8.count <= 1200)
        #expect(text.contains("Setup didn't finish"))
        #expect(text.contains("Mac: Apple silicon"))
        #expect(text.contains("log line number 30"))
        #expect(!text.contains("log line number 1 "))
    }

    @Test func summaryNamesStepAndFacts() {
        let s = report().summary
        #expect(s.contains("Start Squeak") && s.contains("arm64") && s.contains("2.23.1"))
    }
}
