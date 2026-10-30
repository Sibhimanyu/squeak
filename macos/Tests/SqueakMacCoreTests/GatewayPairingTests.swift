import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct GatewayPairingTests {
    private func view(_ json: String) throws -> GatewayView {
        try JSONDecoder().decode(GatewayView.self, from: Data(json.utf8))
    }

    @Test func decodesEveryPairingState() throws {
        for s in ["waiting", "request", "done", "expired"] {
            let v = try view(#"{"pairing":{"state":"\#(s)","expiresAt":1000},"status":{"state":"none"}}"#)
            #expect(v.pairing?.state.rawValue == s)
        }
        let v = try view(#"{"pairing":{"state":"request","expiresAt":5,"name":"Squeak Voice","version":"0.7.0","verify":"4821"},"status":{"state":"none"}}"#)
        #expect(v.pairing?.verify == "4821" && v.pairing?.version == "0.7.0" && v.pairing?.name == "Squeak Voice")
        #expect(try view(#"{"pairing":null,"status":{"state":"none"}}"#).pairing == nil)
    }

    @Test func decodesEveryStatusState() throws {
        for s in ["none", "stale", "ok", "sipDown"] {
            #expect(try view(#"{"pairing":null,"status":{"state":"\#(s)"}}"#).status.state.rawValue == s)
        }
        let v = try view(#"{"pairing":null,"status":{"state":"sipDown","version":"0.7.0","sipRegistered":false,"sipError":"timeout","at":1.7e12}}"#)
        #expect(v.status.sipRegistered == false && v.status.sipError == "timeout" && v.status.at == 1.7e12)
    }

    @Test func toleratesUnknownAndMissing() throws {
        let v = try view(#"{"pairing":{"state":"mystery"},"status":{"state":"???"}}"#)
        #expect(v.pairing?.state == .waiting && v.status.state == .none)
        let empty = try view("{}")
        #expect(empty.pairing == nil && empty.status.state == .none && !empty.isPaired)
    }

    @Test func statusLines() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        #expect(GatewayText.statusLine(GatewayStatus(), now: now) == "No gateway paired yet")
        #expect(GatewayText.statusLine(GatewayStatus(state: .ok, version: "0.7.0"), now: now) == "Home Assistant add-on 0.7.0 · connected")
        #expect(GatewayText.statusLine(GatewayStatus(state: .stale, at: (1_000_000 - 240) * 1000), now: now) == "Not heard from in 4 min")
        #expect(GatewayText.statusLine(GatewayStatus(state: .stale), now: now) == "Not heard from lately")
        #expect(GatewayText.statusLine(GatewayStatus(state: .sipDown, sipError: "401"), now: now) == "Add-on can't reach your PBX: 401")
        #expect(GatewayText.statusLine(GatewayStatus(state: .sipDown), now: now) == "Add-on can't reach your PBX")
    }

    @Test func requestSentenceAndCountdown() {
        let p = GatewayPairing(state: .request, version: "0.7.0", verify: "4821")
        #expect(GatewayText.requestSentence(p) == "Squeak Voice (add-on 0.7.0) wants to connect. Confirm 4821 matches the number in the add-on's log.")
        let now = Date(timeIntervalSince1970: 100)
        #expect(GatewayText.countdown(expiresAt: 100_000 + 545_000, now: now) == "9:05")
        #expect(GatewayText.countdown(expiresAt: 99_000, now: now) == nil)
    }

    @Test func decodesPairResponse() throws {
        let r = try JSONDecoder().decode(GatewayPairResponse.self, from: Data(#"{"ok":true,"code":"SQ1-abc","expiresAt":1.7e12}"#.utf8))
        #expect(r.ok && r.code == "SQ1-abc" && r.expiresAt == 1.7e12)
    }

    @Test func approveBodiesAreExact() {
        #expect(String(decoding: GatewayText.approveBody(true), as: UTF8.self) == #"{"approve":true}"#)
        #expect(String(decoding: GatewayText.approveBody(false), as: UTF8.self) == #"{"approve":false}"#)
    }
}

@Suite struct GatewayClaimTests {
    @Test func bodyIsSortedAndNormalised() {
        #expect(String(data: GatewayClaim.requestBody(code: " k7m2 qx9p "), encoding: .utf8) == #"{"code":"K7M2-QX9P"}"#)
        #expect(String(data: GatewayClaim.requestBody(code: "k7m2-qx9p"), encoding: .utf8) == #"{"code":"K7M2-QX9P"}"#)
    }

    @Test func displayAsTyped() {
        #expect(GatewayClaim.display("k7m") == "K7M")
        #expect(GatewayClaim.display("k7m2q") == "K7M2-Q")
        #expect(GatewayClaim.display("k7m2qx9pzz") == "K7M2-QX9P")
        #expect(GatewayClaim.isComplete("K7M2QX9P") && !GatewayClaim.isComplete("K7M2-QX"))
    }

    @Test func outcomes() {
        #expect(GatewayClaim.outcome(status: 200, body: Data(#"{"ok":true,"name":"Squeak Voice","version":"0.9.0"}"#.utf8)) == .found(name: "Squeak Voice", version: "0.9.0"))
        #expect(GatewayClaim.outcome(status: 404, body: Data(#"{"error":"That code isn't showing on an add-on."}"#.utf8)) == .refused("That code isn't showing on an add-on."))
        #expect(GatewayClaim.outcome(status: 404, body: Data("not found".utf8)) == .unavailable)
        #expect(GatewayClaim.outcome(status: 503, body: Data(#"{"error":"Phone calls need your own Firebase"}"#.utf8)) == .refused("Phone calls need your own Firebase"))
        #expect(GatewayClaim.outcome(status: 400, body: Data()) == .refused("Squeak could not use that code. Check it and try again."))
    }

    @Test func confirmSentence() {
        #expect(GatewayClaimText.confirm(GatewayPairing(state: .request, name: "Squeak Voice", version: "0.9.0")) == "Squeak Voice (add-on 0.9.0) wants to connect.")
    }
}

@Suite struct PauseTests {
    @Test func bodies() {
        let want: [(VoicePauseChoice, String)] = [(.oneHour, "1h"), (.fourHours, "4h"), (.tomorrow, "tomorrow"), (.forever, "forever"), (.resume, "resume")]
        for (c, w) in want { #expect(String(data: c.requestBody(), encoding: .utf8) == #"{"pause":"\#(w)"}"#) }
    }

    @Test func decodesPauseTolerantly() throws {
        func v(_ j: String) throws -> VoiceSettings { try JSONDecoder().decode(VoiceSettings.self, from: Data(j.utf8)) }
        let old = try v(#"{"mode":"gateway"}"#)
        #expect(!old.pauseKnown && old.pause == nil)
        let off = try v(#"{"mode":"gateway","pause":null}"#)
        #expect(off.pauseKnown && off.pause == nil)
        let timed = try v(#"{"mode":"gateway","pause":{"until":5000}}"#)
        #expect(timed.pauseKnown && timed.pause == VoicePause(until: 5000))
        let forever = try v(#"{"mode":"gateway","pause":{"until":null}}"#)
        #expect(forever.pause == VoicePause(until: nil))
    }

    @Test func statusLines() {
        let now = Date(timeIntervalSince1970: 1000)
        let t: (Date, Date) -> String = { _, _ in "3:40 PM" }
        #expect(PauseText.statusLine(nil, now: now, time: t) == "Calls are on")
        #expect(PauseText.statusLine(VoicePause(until: 2_000_000), now: now, time: t) == "Paused until 3:40 PM")
        #expect(PauseText.statusLine(VoicePause(until: nil), now: now, time: t) == "Paused until you turn it back on")
        #expect(PauseText.statusLine(VoicePause(until: 500_000), now: now, time: t) == "Calls are on")
        #expect(PauseText.isPaused(VoicePause(until: nil)) && !PauseText.isPaused(nil))
    }
}

@Suite struct GatewayUpdateTests {
    private func view(_ json: String) throws -> GatewayView {
        try JSONDecoder().decode(GatewayView.self, from: Data(json.utf8))
    }

    @Test func decodesUpdateFieldsAndToleratesAbsence() throws {
        let v = try view(#"{"status":{"state":"ok","version":"0.9.2"},"latestVersion":"0.10.0","updateAvailable":true}"#)
        #expect(v.updateAvailable && v.latestVersion == "0.10.0")
        #expect(v.updateLine == "Add-on 0.9.2 · 0.10.0 is available")
        let old = try view(#"{"status":{"state":"ok"}}"#)
        #expect(!old.updateAvailable && old.latestVersion == nil && old.updateLine == nil)
        #expect(try view(#"{"updateAvailable":"yes","latestVersion":5}"#).updateAvailable == false)
    }

    @Test func requestBodyAndOutcomes() {
        #expect(String(decoding: GatewayUpdate.requestBody, as: UTF8.self) == "{}")
        #expect(GatewayUpdate.outcome(status: 200, body: Data(#"{"ok":true}"#.utf8)) == .done)
        #expect(GatewayUpdate.outcome(status: 400, body: Data(#"{"error":"The add-on is already on the newest version."}"#.utf8))
            == .refused("The add-on is already on the newest version."))
        #expect(GatewayUpdate.outcome(status: 404, body: Data()) == .unavailable)
        if case .refused(let s) = GatewayUpdate.outcome(status: 500, body: Data("x".utf8)) { #expect(!s.isEmpty) } else { Issue.record("expected refused") }
    }
}
