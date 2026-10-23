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

    @Test func safetyRulesUseTheDaemonsNumbersAndFallBackToFortyAndTen() {
        let rules = DaemonAwakeRules(lowPowerPercent: 35, endPercent: 8, heat: true)
        #expect(AwakeFormat.lowPowerTitle(rules) == "Low Power Mode at 35%")
        #expect(AwakeFormat.endTitle(rules) == "Ends at 8%")
        #expect(AwakeFormat.lowPowerDetail(rules).contains("drops to 35% or your Mac runs hot"))
        #expect(AwakeFormat.endDetail(rules).contains("at 8% battery or when your Mac gets very hot"))
        // An older daemon says nothing: the numbers it always enforced.
        #expect(AwakeFormat.lowPowerTitle(nil) == "Low Power Mode at 40%")
        #expect(AwakeFormat.endTitle(nil) == "Ends at 10%")
        // Without heat the lines don't promise it.
        let cool = DaemonAwakeRules(lowPowerPercent: 30, endPercent: 5, heat: false)
        #expect(!AwakeFormat.lowPowerDetail(cool).contains("hot"))
        #expect(!AwakeFormat.endDetail(cool).contains("hot"))
    }

    @Test func decodesTheRules() throws {
        let json = #"{"active":[],"keepAwake":false,"awakeRules":{"lowPowerPercent":35,"endPercent":8,"heat":true}}"#
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8))
        #expect(state.awakeRules == DaemonAwakeRules(lowPowerPercent: 35, endPercent: 8, heat: true))
        let older = try JSONDecoder().decode(DaemonState.self, from: Data(#"{"active":[]}"#.utf8))
        #expect(older.awakeRules == nil)
    }

    @Test func hotspotInputIsCheckedLikeTheDaemonChecksIt() {
        #expect(AwakeFormat.hotspotProblem(ssid: "Sibhi's iPhone", password: "secret-pass") == nil)
        #expect(AwakeFormat.hotspotProblem(ssid: "  ", password: "secret-pass") != nil)
        #expect(AwakeFormat.hotspotProblem(ssid: String(repeating: "a", count: 33), password: "secret-pass") != nil)
        #expect(AwakeFormat.hotspotProblem(ssid: "bad\nname", password: "secret-pass") != nil)
        #expect(AwakeFormat.hotspotProblem(ssid: "Phone", password: "short") != nil)
        #expect(AwakeFormat.hotspotProblem(ssid: "Phone", password: String(repeating: "a", count: 64)) != nil)
        #expect(AwakeFormat.hotspotProblem(ssid: "Phone", password: "ünicode!!") != nil)
        // No password: only fine when this name is already saved with one.
        #expect(AwakeFormat.hotspotProblem(ssid: "Phone", password: "") == "Enter the hotspot's password.")
        #expect(AwakeFormat.hotspotProblem(ssid: "Phone", password: "", keepsPassword: true) == nil)
    }

    @Test func heatReadsAsOneLine() throws {
        let json = #"{"keepAwake":true,"awake":{},"heat":{"level":"warm","die":91,"battery":41,"fansRpm":[7800,7700],"fansMax":true,"fanControl":true,"slowed":3,"why":"Running warm · chip 91°C, battery 41°C · fans on full · agents slowed"}}"#
        let heat = try #require(try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8)).heat)
        #expect(heat == DaemonHeat(level: "warm", die: 91, battery: 41, fansRpm: [7800, 7700], fansMax: true, fanControl: true, slowed: 3,
                                   why: "Running warm · chip 91°C, battery 41°C · fans on full · agents slowed"))
        #expect(AwakeFormat.heatTitle(heat) == "Warm")
        let en = Locale(identifier: "en_US")
        #expect(AwakeFormat.heatReading(heat, locale: en) == "Chip 91°C · Battery 41°C · Fans 7,800 rpm, full")
        #expect(AwakeFormat.heatReading(DaemonHeat(die: 50, fansRpm: [0, 0]), locale: en) == "Chip 50°C · Fans off")
        #expect(AwakeFormat.heatReading(DaemonHeat()) == nil)
        // An older daemon sends no heat at all.
        #expect(try JSONDecoder().decode(DaemonState.self, from: Data(#"{"keepAwake":false}"#.utf8)).heat == nil)
    }
}
