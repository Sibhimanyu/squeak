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
