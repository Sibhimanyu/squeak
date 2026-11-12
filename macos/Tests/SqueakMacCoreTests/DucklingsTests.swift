import Foundation
import Testing
@testable import SqueakMacCore

struct DucklingsTests {
    @Test func decodesOptionallyAndLeniently() throws {
        let json = #"""
        {"id":"s1","ducklings":{"running":1,"items":[
          {"id":"t1","kind":"agent","title":"Scan","model":"Sonnet 5.5","status":"running","startedAt":"2026-11-12T10:00:00Z"},
          {"id":"t2","kind":"shell","title":"npm test","status":"done","startedAt":"2026-11-12T10:00:00Z","endedAt":"2026-11-12T10:01:30Z","summary":"ok"},
          {"title":"no id"}]}}
        """#
        let s = try JSONDecoder().decode(NativeSession.self, from: Data(json.utf8))
        #expect(s.ducklings?.running == 1 && s.ducklings?.items.count == 2)
        #expect(s.ducklings?.items[1].elapsed() == "1m" && s.ducklings?.items[1].kind == .shell)
        let old = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"s1"}"#.utf8))
        #expect(old.ducklings == nil)
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"ducklingsRunning":3}"#.utf8))
        #expect(state.ducklingsRunning == 3)
        #expect(try JSONDecoder().decode(DaemonState.self, from: Data("{}".utf8)).ducklingsRunning == nil)
        let d = try JSONDecoder().decode(DaemonSession.self, from: Data(#"{"key":"k","ducklings":{"running":2,"items":[]}}"#.utf8))
        #expect(NativeAdapter.started(NativeSession(id: "x", ducklings: d.ducklings)).ducklings?.running == 2)
    }

    @Test func finishedChipsLeaveTheBarOnceReported() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        func at(_ s: Double) -> Date { t0.addingTimeInterval(s) }
        let running = Duckling(id: "r", title: "r", status: .running, startedAt: t0)
        let done = Duckling(id: "d", title: "d", status: .done, startedAt: t0, endedAt: t0)
        let reported = Duckling(id: "p", title: "p", status: .done, startedAt: t0, endedAt: t0, reportedAt: at(5))
        let failed = Duckling(id: "f", title: "f", status: .failed, startedAt: t0, endedAt: t0)
        let failedReported = Duckling(id: "g", title: "g", status: .failed, startedAt: t0, endedAt: t0, reportedAt: at(8))
        #expect(running.isShownInBar(now: at(9999)))
        #expect(done.isShownInBar(now: at(19)) && !done.isShownInBar(now: at(20)))       // no reportedAt: 20 s
        #expect(reported.isShownInBar(now: at(4)) && !reported.isShownInBar(now: at(5))) // reported: gone
        #expect(failed.isShownInBar(now: at(600)))                                       // waits for the report
        #expect(failedReported.isShownInBar(now: at(7)) && !failedReported.isShownInBar(now: at(8)))
        let set = DucklingSet(running: 1, items: [running, done, reported, failed])
        #expect(set.barItems(now: at(30)).map(\.id) == ["r", "f"])
        // nothing runs and nothing pending: no bar at all
        #expect(DucklingWords.barText(DucklingSet(running: 0, items: [done, reported]), now: at(30)) == nil)
        #expect(DucklingWords.barText(DucklingSet(running: 0, items: [done]), now: at(10)) == "Background work finished")
        #expect(DucklingWords.barText(DucklingSet(running: 0, items: [failed]), now: at(30)) == "Background work finished, one failed")
        #expect(DucklingWords.barText(DucklingSet(running: 1, items: [done]), now: at(30)) == "1 in the background")
    }

    @Test func decodesReportedAt() throws {
        let d = try JSONDecoder().decode(Duckling.self, from: Data(#"{"id":"t","status":"done","reportedAt":"2026-11-12T10:02:00Z"}"#.utf8))
        #expect(d.reportedAt != nil)
        #expect(try JSONDecoder().decode(Duckling.self, from: Data(#"{"id":"t"}"#.utf8)).reportedAt == nil)
    }

    @Test func words() {
        #expect(DucklingWords.readyLine(running: 0) == nil)
        #expect(DucklingWords.readyLine(running: 1) == "Ready · 1 duckling running")
        #expect(DucklingWords.barText(DucklingSet(running: 3)) == "3 in the background")
        #expect(DucklingWords.barText(nil) == nil && DucklingWords.barText(DucklingSet(running: 0)) == nil)
        #expect(DucklingWords.dashboardFigure(running: 0, threads: 0) == nil)
        #expect(DucklingWords.dashboardFigure(running: 3, threads: 1) == "3 ducklings running · 1 thread")
        let start = Date(timeIntervalSince1970: 0)
        let d = Duckling(id: "a", title: "Scan", model: "Sonnet 5.5", startedAt: start)
        #expect(d.chipText(now: start.addingTimeInterval(240)) == "Scan · Sonnet 5.5 · 4m")
        #expect(d.elapsed(now: start.addingTimeInterval(3900)) == "1h 5m")
    }

    @Test func helpersNeverHoldTheDockOpenOnAHostThatReportsThem() {
        func dock(_ set: DucklingSet?, bg: Int) -> ChatDock.Resolved {
            ChatDock.resolve(
                liveState: .idle, messages: [], awaitingApproval: false, backgroundCount: bg, backgroundWaiting: false,
                hostStatus: "idle", hostBackgroundCount: bg, optimistic: false, hostOwnsState: true, hasStopRoute: true,
                activity: [], model: nil, ducklings: set)
        }
        #expect(!dock(DucklingSet(running: 2), bg: 2).showsRow && dock(DucklingSet(running: 2), bg: 2).readyLine == "Ready · 2 ducklings running")
        #expect(dock(nil, bg: 2).showsRow && dock(nil, bg: 2).readyLine == nil)
    }
}
