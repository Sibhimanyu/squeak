import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct VoiceReadinessTests {
    private func decode(_ json: String) throws -> VoiceReadiness {
        try JSONDecoder().decode(VoiceReadiness.self, from: Data(json.utf8))
    }
    private let now = Date(timeIntervalSince1970: 1_000_000)

    @Test func stepsAreWorded() throws {
        let a = try decode(#"{"state":"preparing","step":"loading","voice":"Sohee","since":1}"#).line(now: now)
        #expect(a?.text == "Getting Sohee ready for calls: loading the voice…" && a?.kind == .preparing && a?.fraction == nil)
        let b = try decode(#"{"state":"preparing","step":"recording","done":12,"total":34,"voice":"Sohee","since":1}"#).line(now: now)
        #expect(b?.text == "Getting Sohee ready for calls: recording call prompts (12 of 34)…")
        #expect(abs((b?.fraction ?? 0) - 12.0 / 34.0) < 0.0001)
        let c = try decode(#"{"state":"preparing","step":"sending","voice":"Sohee","since":1}"#).line(now: now)
        #expect(c?.text == "Getting Sohee ready for calls: sending to the phone add-on…")
    }

    @Test func readyShowsForAMinuteThenGoes() throws {
        let ms = now.timeIntervalSince1970 * 1000
        let fresh = try decode("{\"state\":\"ready\",\"voice\":\"Sohee\",\"since\":\(ms - 5000)}")
        #expect(fresh.line(now: now)?.text == "Sohee is ready for calls." && fresh.line(now: now)?.kind == .ready)
        let old = try decode("{\"state\":\"ready\",\"voice\":\"Sohee\",\"since\":\(ms - 61000)}")
        #expect(old.line(now: now) == nil)
    }

    @Test func partialStays() throws {
        let r = try decode(#"{"state":"ready","voice":"Sohee","since":1,"partial":{"recorded":22,"total":34}}"#)
        #expect(r.line(now: now)?.text == "Sohee is ready for calls; 12 of 34 prompts are still in the add-on's voice until the next update.")
    }

    @Test func failureIsTheReasonAsAWarning() throws {
        let r = try decode(#"{"state":"failed","voice":"Sohee","since":1,"reason":"The new voice could not start; calls use the add-on's voice."}"#)
        #expect(r.line(now: now)?.kind == .warning)
        #expect(r.line(now: now)?.text == "The new voice could not start; calls use the add-on's voice.")
    }

    @Test func olderDaemonHasNoLineAndUnknownStateDrawsNothing() throws {
        let v = try JSONDecoder().decode(NaturalVoice.self, from: Data(#"{"installed":true,"enabled":true,"voice":"af_heart"}"#.utf8))
        #expect(v.readiness == nil)
        let w = try JSONDecoder().decode(NaturalVoice.self, from: Data(#"{"installed":true,"enabled":true,"voice":"x","readiness":{"state":"preparing","step":"loading","voice":"Y","since":1}}"#.utf8))
        #expect(w.readiness?.isPreparing == true)
        #expect(try decode(#"{"state":"weird","voice":"a","since":1}"#).line(now: now) == nil)
    }
}
