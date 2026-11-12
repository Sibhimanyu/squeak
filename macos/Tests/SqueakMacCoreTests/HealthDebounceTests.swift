import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct HealthDebounceTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    func h(_ s: ConnectionStatus) -> AdapterHealth { AdapterHealth(adapterId: "a", status: s) }

    @Test func blipUnderGraceStaysConnected() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        #expect(d.reduce(h(.daemonDown), now: t0.addingTimeInterval(1)).status == .connected)
        #expect(d.reduce(h(.degraded("x")), now: t0.addingTimeInterval(14)).status == .connected)
    }

    @Test func failureAfterGraceIsReported() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(1))
        #expect(d.reduce(h(.daemonDown), now: t0.addingTimeInterval(16)).status == .daemonDown)
    }

    @Test func recoveryIsImmediateAndRestartsTheClock() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(1))
        #expect(d.reduce(h(.daemonDown), now: t0.addingTimeInterval(20)).status == .daemonDown)
        #expect(d.reduce(h(.connected), now: t0.addingTimeInterval(21)).status == .connected)
        #expect(d.reduce(h(.daemonDown), now: t0.addingTimeInterval(22)).status == .connected)
    }

    @Test func rejectedAndMissingTokenAreNotDebounced() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        let r = d.reduce(h(.degraded("rejected")), immediate: true, now: t0.addingTimeInterval(1))
        #expect(r.status == .degraded("rejected"))
        #expect(d.reduce(h(.tokenMissing), now: t0.addingTimeInterval(2)).status == .tokenMissing)
    }

    @Test func neverConnectedReportsAtOnce() {
        var d = HealthDebounce()
        #expect(d.reduce(h(.daemonDown), now: t0).status == .daemonDown)
    }
}
