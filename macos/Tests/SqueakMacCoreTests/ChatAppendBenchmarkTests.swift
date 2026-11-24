import Foundation
import SQLite3
import Testing
@testable import SqueakMacCore

/// Times the pure work one appended timeline event costs the open chat (reduce, present, build the feed, derive the rows)
/// on the biggest real chat in the host's database, read-only. The content stays local: events are read at test time and
/// the test is skipped when the database is not there (CI). Run with `SQUEAK_BENCH=1` to print the numbers.
struct ChatAppendBenchmarkTests {
    static let dbPath = NSString(string: "~/Library/Application Support/squeak/native.db").expandingTildeInPath

    /// The newest `turns` turns' events of the chat with the most timeline events, oldest first.
    static func events(turns: Int) -> [TimelineEvent]? {
        guard FileManager.default.fileExists(atPath: dbPath) else { return nil }
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_close(db) }
        func rows(_ sql: String, _ bind: String? = nil) -> [[String]] {
            var st: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK else { return [] }
            defer { sqlite3_finalize(st) }
            if let bind { sqlite3_bind_text(st, 1, bind, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            var out: [[String]] = []
            while sqlite3_step(st) == SQLITE_ROW {
                out.append((0..<sqlite3_column_count(st)).map { sqlite3_column_text(st, $0).map { String(cString: $0) } ?? "" })
            }
            return out
        }
        guard let chat = rows("select session_id from timeline_events group by 1 order by count(*) desc limit 1").first?.first else { return nil }
        let starts = rows("select seq from timeline_events where session_id = ?1 and type = 'turn.started' order by seq desc limit \(turns)", chat)
        guard let from = starts.last.flatMap({ Int($0[0]) }) else { return nil }
        let raw = rows("select seq, body from timeline_events where session_id = ?1 and seq >= \(from) order by seq", chat)
        return raw.compactMap { r in
            guard let data = r[1].data(using: .utf8), var obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let seq = Int(r[0]) else { return nil }
            obj["seq"] = seq
            guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
            return try? JSONDecoder().decode(TimelineEvent.self, from: d)
        }
    }

    struct Stage { var name: String; var total: Double = 0 }

    @Test func timeOneAppendOnTheBiggestRealChat() throws {
        for turns in [30, 70] {
            guard let events = Self.events(turns: turns), events.count > 120 else { return }
            let tail = 100
            var t = TurnTimeline()
            t.load(Array(events.dropLast(tail)), hasEarlier: false)
            var prev = TimelinePresentation(t, now: Date())
            var stages = ["apply", "present", "compare", "feed", "rows"].map { Stage(name: $0) }
            let rowsCache = ChatRowsCache(), derived = RowDerivedCache()
            let clock = ContinuousClock()
            func time(_ i: Int, _ f: () -> Void) { let d = clock.measure(f); stages[i].total += Double(d.components.attoseconds) / 1e15 + Double(d.components.seconds) * 1000 }
            for e in events.suffix(tail) {
                time(0) { t.apply(e) }
                var cur = prev
                time(1) { cur = TimelinePresentation(t, now: Date()) }
                time(2) { _ = cur == prev; _ = cur.changedRows(from: prev) }
                time(3) { _ = ChatFeed(t) }
                time(4) { let r = rowsCache.rows(messages: cur.messages, state: .working); _ = derived.derived(rows: r, generation: rowsCache.generation) }
                prev = cur
            }
            let line = stages.map { "\($0.name) \(String(format: "%.3f", $0.total / Double(tail)))ms" }.joined(separator: " · ")
            if ProcessInfo.processInfo.environment["SQUEAK_BENCH"] != nil {
                print("BENCH turns=\(turns) steps=\(t.turns.reduce(0) { $0 + $1.steps.count }) per append: \(line)")
            }
            #expect(stages.reduce(0) { $0 + $1.total } / Double(tail) < 500)
        }
    }
}
