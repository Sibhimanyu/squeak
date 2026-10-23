import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Awake wording")
struct AwakeFormatTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func timeLeft() {
        #expect(AwakeFormat.left(until: now.addingTimeInterval(130 * 60), now: now) == "2h 10m left")
        #expect(AwakeFormat.left(until: now.addingTimeInterval(120 * 60), now: now) == "2h left")
        #expect(AwakeFormat.left(until: now.addingTimeInterval(45 * 60), now: now) == "45m left")
        #expect(AwakeFormat.left(until: now.addingTimeInterval(20), now: now) == "under a minute left")
        #expect(AwakeFormat.left(until: now.addingTimeInterval(-5), now: now) == "ending now")
        #expect(AwakeFormat.left(until: nil, now: now) == nil)
    }

    @Test func headline() {
        #expect(AwakeFormat.headline(nil) == "Off")
        #expect(AwakeFormat.headline(DaemonAwake(until: nil)) == "On until you end it")
        let h = AwakeFormat.headline(DaemonAwake(until: now), locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
        #expect(h.hasPrefix("On until "))
    }

    @Test func lidStates() {
        #expect(AwakeFormat.lid(DaemonAwake(until: now)) == .open)
        #expect(AwakeFormat.lid(DaemonAwake(until: now, lid: true, lidStatus: "on")) == .on)
        #expect(AwakeFormat.lid(DaemonAwake(until: now, lid: true, lidStatus: "starting")) == .starting)
        #expect(AwakeFormat.lid(DaemonAwake(until: now, lid: true, lidStatus: "failed", lidProblem: "No.")) == .failed("No."))
        // A daemon that names no status but asked for a lid session: draw it as on, never invent a failure.
        #expect(AwakeFormat.lid(DaemonAwake(until: now, lid: true)) == .on)
    }

    @Test func onlySafetyEndsAreSaid() {
        #expect(AwakeFormat.ended(DaemonAwakeEnd(reason: "expired", at: now), now: now) == nil)
        #expect(AwakeFormat.ended(DaemonAwakeEnd(reason: "battery", at: now, why: "Battery at 9%"), now: now)
            == "The last session ended because the battery ran low (Battery at 9%).")
        #expect(AwakeFormat.ended(DaemonAwakeEnd(reason: "heat", at: now.addingTimeInterval(-7 * 3600)), now: now) == nil)
    }

    @Test func decodesTheRichState() throws {
        let json = #"{"active":[],"keepAwake":true,"awake":{"until":null,"lid":true,"lidStatus":"failed","lidProblem":"x","lowPower":true,"safety":"Battery at 38%"},"awakeLidActions":{"displayOff":true,"mute":false,"lowPower":true,"freezeApps":true},"awakeLastEnd":{"reason":"battery","at":"2026-10-20T04:26:41.785Z"},"awakeSleepProblem":"p","hotspot":{"configured":true,"ssid":"S","enabled":true,"onHotspot":false,"last":{"note":"Joined","ok":true}}}"#
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
        #expect(state.awake?.lidStatus == "failed" && state.awake?.safety == "Battery at 38%" && state.awake?.lowPower == true)
        #expect(state.awakeLidActions == DaemonLidActions(displayOff: true, mute: false, lowPower: true, freezeApps: true))
        #expect(state.awakeLastEnd?.reason == "battery" && state.awakeSleepProblem == "p")
        #expect(state.hotspot?.lastNote == "Joined")
    }
}
