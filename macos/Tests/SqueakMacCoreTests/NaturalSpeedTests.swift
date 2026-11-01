import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct NaturalSpeedTests {
    private func decode(_ json: String) throws -> NaturalVoice {
        try JSONDecoder().decode(NaturalVoice.self, from: Data(json.utf8))
    }

    @Test func stepsAndTitles() {
        #expect(NaturalSpeed.steps == [0.8, 0.9, 1.0, 1.1, 1.2, 1.3])
        #expect(NaturalSpeed.steps.map(NaturalSpeed.title) == ["0.8×", "0.9×", "1×", "1.1×", "1.2×", "1.3×"])
    }

    @Test func speedIsReadWhenSentAndHiddenWhenNot() throws {
        let with = try decode(#"{"installed":true,"enabled":true,"voice":"af_heart","speed":1.2}"#)
        #expect(with.speedStep == 1.2)
        let without = try decode(#"{"installed":true,"enabled":true,"voice":"af_heart"}"#)
        #expect(without.speedStep == nil)
        let odd = try decode(#"{"installed":true,"enabled":true,"voice":"af_heart","speed":1.07}"#)
        #expect(odd.speedStep == 1.0)
    }

    @Test func requestBodyCarriesOnlySpeed() throws {
        let body = try #require(JSONSerialization.jsonObject(with: NaturalVoice.requestBody(speed: 0.9)) as? [String: Any])
        let inner = try #require(body["natural"] as? [String: Any])
        #expect(inner.count == 1)
        #expect(inner["speed"] as? Double == 0.9)
        let none = try #require(JSONSerialization.jsonObject(with: NaturalVoice.requestBody(emotion: .strong)) as? [String: Any])
        #expect((none["natural"] as? [String: Any])?["speed"] == nil)
    }
}
