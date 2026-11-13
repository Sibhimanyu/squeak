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
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(8))
        #expect(d.reduce(h(.daemonDown), now: t0.addingTimeInterval(16)).status == .daemonDown)
    }

    @Test func oneOrTwoSlowAnswersNeverFlipEvenAfterTheGrace() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        // Two timeouts 20 s apart: time has passed but there is no evidence of a lasting problem.
        _ = d.reduce(h(.degraded("Squeak is not answering")), now: t0)
        #expect(d.reduce(h(.degraded("Squeak is not answering")), now: t0.addingTimeInterval(20)).status == .connected)
    }

    @Test func aSlowServiceNeedsThreeFailuresAndTheLongerGrace() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        let slow = h(.degraded("Squeak is not answering"))
        _ = d.reduce(slow, now: t0)
        _ = d.reduce(slow, now: t0.addingTimeInterval(10))
        #expect(d.reduce(slow, now: t0.addingTimeInterval(20)).status == .connected)
        #expect(d.reduce(slow, now: t0.addingTimeInterval(31)).status == .degraded("Squeak is not answering"))
    }

    @Test func aSuccessInTheMiddleClearsTheCount() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(1))
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(8))
        _ = d.reduce(h(.connected), now: t0.addingTimeInterval(9))
        #expect(d.reduce(h(.daemonDown), now: t0.addingTimeInterval(40)).status == .connected)
    }

    @Test func recoveryIsImmediateAndRestartsTheClock() {
        var d = HealthDebounce()
        _ = d.reduce(h(.connected), now: t0)
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(1))
        _ = d.reduce(h(.daemonDown), now: t0.addingTimeInterval(10))
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
