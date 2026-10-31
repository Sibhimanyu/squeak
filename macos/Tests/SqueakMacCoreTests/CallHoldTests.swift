import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct CallHoldTests {
    private func view(_ json: String) throws -> VoiceSettings { try JSONDecoder().decode(VoiceSettings.self, from: Data(json.utf8)) }

    @Test func anOlderDaemonHidesTheGroup() throws {
        #expect(try view(#"{"mode":"gateway"}"#).hold == nil)
    }

    @Test func decodesTheHoldObjectAndFillsDefaults() throws {
        let full = try view(#"{"hold":{"holdAtMac":false,"graceSeconds":60,"awayAfterSeconds":120,"sawItAwayAfterSeconds":300,"maxHoldMinutes":30}}"#).hold
        #expect(full == CallHold(holdAtMac: false, graceSeconds: 60, awayAfterSeconds: 120, sawItAwayAfterSeconds: 300, maxHoldMinutes: 30))
        #expect(try view(#"{"hold":{}}"#).hold == CallHold.defaults)
        #expect(CallHold.defaults == CallHold(holdAtMac: true, graceSeconds: 45, awayAfterSeconds: 90, sawItAwayAfterSeconds: 180, maxHoldMinutes: 15))
    }

    @Test func outOfRangeNumbersArePulledIn() throws {
        let h = try view(#"{"hold":{"graceSeconds":1,"awayAfterSeconds":99999,"sawItAwayAfterSeconds":0,"maxHoldMinutes":500}}"#).hold
        #expect(h?.graceSeconds == 15 && h?.awayAfterSeconds == 900 && h?.sawItAwayAfterSeconds == 30 && h?.maxHoldMinutes == 120)
    }

    @Test func requestBodyCarriesAllFiveKeysAsIntegers() throws {
        let body = CallHold(graceSeconds: 5, maxHoldMinutes: 20).requestBody()
        let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: [String: Any]])
        let hold = try #require(json["hold"])
        #expect(Set(hold.keys) == ["holdAtMac", "graceSeconds", "awayAfterSeconds", "sawItAwayAfterSeconds", "maxHoldMinutes"])
        #expect(hold["graceSeconds"] as? Int == 15)
        #expect(hold["maxHoldMinutes"] as? Int == 20)
        #expect(hold["holdAtMac"] as? Bool == true)
    }

    @Test func spansReadPlainly() {
        #expect(CallHold.span(seconds: 45) == "45 seconds")
        #expect(CallHold.span(seconds: 180) == "3 minutes")
        #expect(CallHold.span(seconds: 90) == "1 min 30 s")
        #expect(CallHold.minutes(1) == "1 minute")
    }
}
