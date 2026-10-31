import Foundation
import XCTest
@testable import SqueakCore

final class VoiceReadinessTests: XCTestCase {
    private func natural(_ json: String) throws -> NaturalVoiceView {
        try JSONDecoder().decode(NaturalVoiceView.self, from: Data(json.utf8))
    }
    private let now = Date(timeIntervalSince1970: 1_000_000)

    func testOlderMacHasNoReadinessOrLine() throws {
        let n = try natural(#"{"installed":true,"enabled":true,"voice":"a"}"#)
        XCTAssertNil(n.readiness)
        XCTAssertNil(VoiceReadinessLine.make(n.readiness, now: now))
    }

    func testDecodesRecording() throws {
        let n = try natural(#"{"installed":true,"enabled":true,"voice":"a","readiness":{"state":"preparing","step":"recording","done":12,"total":34,"voice":"Sohee","since":1}}"#)
        let l = VoiceReadinessLine.make(n.readiness, now: now)
        XCTAssertEqual(l?.text, "Getting Sohee ready for calls: recording call prompts (12 of 34)\u{2026}")
        XCTAssertEqual(l?.style, .working)
        XCTAssertEqual(l?.progress ?? 0, 12.0 / 34.0, accuracy: 1e-9)
    }

    func testLoadingAndSending() {
        let a = VoiceReadiness(state: .preparing, step: .loading, voice: "Sohee")
        XCTAssertEqual(VoiceReadinessLine.make(a, now: now)?.text, "Getting Sohee ready for calls: loading the voice\u{2026}")
        let b = VoiceReadiness(state: .preparing, step: .sending, voice: "Sohee")
        XCTAssertEqual(VoiceReadinessLine.make(b, now: now)?.text, "Getting Sohee ready for calls: sending to the phone add-on\u{2026}")
    }

    func testReadyLineGoesAwayAfterAMinute() {
        let since = now.timeIntervalSince1970 * 1000
        let r = VoiceReadiness(state: .ready, voice: "Sohee", since: since - 30_000)
        XCTAssertEqual(VoiceReadinessLine.make(r, now: now), VoiceReadinessLine(style: .done, text: "Sohee is ready for calls.", progress: nil))
        let old = VoiceReadiness(state: .ready, voice: "Sohee", since: since - 61_000)
        XCTAssertNil(VoiceReadinessLine.make(old, now: now))
    }

    func testPartialStays() {
        let r = VoiceReadiness(state: .ready, partial: .init(recorded: 12, total: 34), voice: "Sohee", since: 0)
        let l = VoiceReadinessLine.make(r, now: now)
        XCTAssertEqual(l?.text, "Sohee is ready for calls; 12 of 34 prompts are still in the add-on's voice until the next update.")
        XCTAssertEqual(l?.style, .warning)
    }

    func testFailedUsesReasonOrFixedSentence() {
        XCTAssertEqual(VoiceReadinessLine.make(VoiceReadiness(state: .failed, reason: "Nope."), now: now)?.text, "Nope.")
        XCTAssertEqual(VoiceReadinessLine.make(VoiceReadiness(state: .failed), now: now)?.text,
                       "The new voice could not start; calls use the add-on's voice.")
    }

    func testUnknownStateDoesNotFailTheView() throws {
        let n = try natural(#"{"installed":true,"enabled":true,"voice":"a","readiness":{"state":"weird"}}"#)
        XCTAssertNil(n.readiness)
        XCTAssertEqual(n.voice, "a")
    }
}
