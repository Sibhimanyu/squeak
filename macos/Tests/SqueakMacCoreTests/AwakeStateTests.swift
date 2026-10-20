import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Awake session and hotspot from /state")
struct AwakeStateTests {
    private func decode(_ json: String) throws -> DaemonState {
        try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
    }

    @Test func readsARunningAwakeSessionAndItsEnd() throws {
        let state = try decode(#"{"active":[],"keepAwake":true,"awake":{"startedAt":"2026-10-20T02:26:41.785Z","until":"2026-10-20T04:26:41.785Z","lid":false,"lidStatus":"off"}}"#)
        #expect(state.awakeOffered)
        #expect(state.awake?.until == DaemonDate.parse("2026-10-20T04:26:41.785Z"))
        #expect(state.awake?.lid == false)
    }

    @Test func noSessionAndAnOlderDaemonReadDifferently() throws {
        let off = try decode(#"{"active":[],"keepAwake":false}"#)
        #expect(off.awakeOffered && off.awake == nil)
        let older = try decode(#"{"active":[]}"#)
        #expect(!older.awakeOffered && older.awake == nil)
        let untilEnded = try decode(#"{"active":[],"keepAwake":true,"awake":{"startedAt":"2026-10-20T02:26:41.785Z","lid":false}}"#)
        #expect(untilEnded.awake != nil && untilEnded.awake?.until == nil)
    }

    @Test func readsTheHotspotWithoutAPassword() throws {
        let state = try decode(#"{"active":[],"hotspot":{"configured":true,"ssid":"Phone","enabled":true,"onHotspot":true,"last":null}}"#)
        #expect(state.hotspot == DaemonHotspot(configured: true, ssid: "Phone", enabled: true, onHotspot: true))
    }
}
