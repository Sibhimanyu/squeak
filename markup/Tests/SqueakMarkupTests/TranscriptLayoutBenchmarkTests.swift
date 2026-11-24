#if os(macOS)
import AppKit
import SQLite3
import SwiftUI
import Testing
@testable import SqueakMarkup

/// Headless (no window): the layout cost of a column of real, long agent messages set with `MessageText`, and of
/// appending one more. The text is read at test time from the host's database (read-only, never committed); skipped
/// when it is absent. `SQUEAK_BENCH=1` prints the numbers.
@MainActor @Suite("Transcript layout benchmark", .serialized)
struct TranscriptLayoutBenchmarkTests {
    static func texts(_ n: Int) -> [String] {
        let path = NSString(string: "~/Library/Application Support/squeak/native.db").expandingTildeInPath
        var db: OpaquePointer?
        guard FileManager.default.fileExists(atPath: path), sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_close(db) }
        var st: OpaquePointer?
        let sql = "select body from timeline_events where type = 'reply.done' and length(body) > 1500 order by rowid desc limit \(n)"
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return [] }
        defer { sqlite3_finalize(st) }
        var out: [String] = []
        while sqlite3_step(st) == SQLITE_ROW {
            guard let c = sqlite3_column_text(st, 0), let obj = try? JSONSerialization.jsonObject(with: Data(String(cString: c).utf8)) as? [String: Any],
                  let t = obj["text"] as? String else { continue }
            out.append(t)
        }
        return out.reversed()
    }

    struct Column: View {
        let items: [String]
        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, t in MessageText(markdown: t, style: .mac) }
            }
            .frame(width: 720)
        }
    }

    @Test func layoutOfLongRealMessagesAndOneAppend() {
        let all = Self.texts(60)
        guard all.count >= 20 else { return }
        let host = NSHostingView(rootView: Column(items: Array(all.prefix(all.count - 1))))
        let clock = ContinuousClock()
        func ms(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }
        let first = ms(clock.measure { _ = host.fittingSize })
        var appends: [Double] = []
        for k in 1...5 {
            let n = all.count - 1 + (k % 2)
            host.rootView = Column(items: Array(all.prefix(n)))
            appends.append(ms(clock.measure { _ = host.fittingSize }))
        }
        if ProcessInfo.processInfo.environment["SQUEAK_BENCH"] != nil {
            print("BENCH layout rows=\(all.count) first=\(String(format: "%.1f", first))ms append/relayout=\(appends.map { String(format: "%.1f", $0) })ms")
        }
        #expect(first > 0)
    }
}
#endif
