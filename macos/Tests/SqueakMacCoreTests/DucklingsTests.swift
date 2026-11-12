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
