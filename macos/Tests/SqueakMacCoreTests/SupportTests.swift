import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Diagnostics redaction")
struct DiagnosticsTests {
    @Test func redactsPathsIdsTokensUrlsAndEmails() {
        let line = "opened /Users/jane/work/secret-project/file.ts for 3f2a9c1e-1111-4222-8333-444455556666 via https://x.example/a?b=1 jane@example.com tok=abcdefghijklmnopqrstuvwxyz0123456789"
        let out = DiagnosticsRedactor.redact(line)
        for leak in ["jane", "secret-project", "3f2a9c1e", "x.example", "abcdefghijkl"] { #expect(!out.contains(leak), "\(leak) leaked: \(out)") }
        #expect(out.contains("<path>") && out.contains("<id>") && out.contains("<url>") && out.contains("<email>"))
    }

    @Test func keepsPlainWording() {
        #expect(DiagnosticsRedactor.redact("poll ok: 12 sessions") == "poll ok: 12 sessions")
    }

    @Test func hashIsEightHexAndStable() {
        let h = DiagnosticsRedactor.hash("session-1")
        #expect(h.count == 8 && h.allSatisfy(\.isHexDigit))
        #expect(h == DiagnosticsRedactor.hash("session-1") && h != DiagnosticsRedactor.hash("session-2"))
    }

    @Test func ringBufferKeepsTheNewest() {
        let b = LogBuffer(capacity: 3)
        for i in 1...5 { b.append("line \(i)") }
        let last = b.last(10)
        #expect(last.count == 3 && last[0].hasSuffix("line 3") && last[2].hasSuffix("line 5"))
    }

    @Test func reportHasCountsAndVersionsButNeverContent() {
        let s = makeSession("secret-id", title: "My Private Title", state: .working)
        let input = DiagnosticsInput(
            appVersion: "2.0.0", osVersion: "macOS 15.0",
            adapters: [.init(name: "Conductor database", status: "connected", lastSyncedAt: Date(timeIntervalSince1970: 1_800_000_000))],
            stateCounts: DiagnosticsInput.counts(of: [s, makeSession("b", state: .blocked)]),
            lastUpdateCheck: nil,
            logLines: (1...80).map { "line \($0) /Users/jane/x/y" },
            now: Date(timeIntervalSince1970: 1_800_000_100))
        let r = DiagnosticsReport.render(input)
        #expect(r.contains("App version: 2.0.0") && r.contains("working: 1") && r.contains("blocked: 1") && r.contains("Last update check: never"))
        #expect(!r.contains("My Private Title") && !r.contains("secret-id") && !r.contains("jane"))
        #expect(r.contains("line 80") && !r.contains("line 30 ") && r.contains("line 31 "))
        #expect(DiagnosticsInput.describe(.degraded("/Users/jane/db")) == "degraded")
    }
}

@Suite("Connections report")
struct ConnectionsReportTests {
    let ok = AdapterHealth(adapterId: "x", status: .connected)

    @Test func allGood() {
        let db = ConnectionsReport.Row(title: "Some database", value: "Readable", level: .ok)
        let r = ConnectionsReport.make(addonRows: [db], daemonHealth: ok, tokenPresent: true)
        #expect(r.addonRows == [db] && r.daemon.value == "Connected" && r.sending.value == "Available via Squeak service")
        #expect(ConnectionsReport.make(daemonHealth: ok, tokenPresent: true).addonRows.isEmpty)
    }

    @Test func daemonDownTokenMissing() {
        let down = AdapterHealth(adapterId: "d", status: .daemonDown)
        let a = ConnectionsReport.make(daemonHealth: down, tokenPresent: true)
        #expect(a.daemon.value == "Down" && a.sending.value == "Unavailable")
        let b = ConnectionsReport.make(daemonHealth: ok, tokenPresent: false)
        #expect(b.daemon.value == "Token missing" && b.sending.value == "Unavailable" && b.sending.detail?.contains("token") == true)
    }
}
