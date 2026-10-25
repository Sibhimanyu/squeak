import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Notification settings")
struct NotifySettingsTests {
    static let wire = """
    {"telegram":{"muted":false,"approval":true,"question":false,"stalled":true,"quota":true,"finished":"all","quiet":null},
     "cliq":{"muted":true,"approval":true,"question":true,"stalled":true,"quota":false,"finished":"off","quiet":{"from":"22:00","to":"07:00"}},
     "channels":{"telegram":true,"cliq":false}}
    """

    private func decode(_ json: String) throws -> NotifySettings {
        try JSONDecoder().decode(NotifySettings.self, from: Data(json.utf8))
    }

    @Test func decodesTheDaemonsShape() throws {
        let s = try decode(Self.wire)
        #expect(s.telegram?.question == false)
        #expect(s.telegram?.finished == .all)
        #expect(s.telegram?.quiet == nil)
        #expect(s.cliq?.muted == true)
        #expect(s.cliq?.quiet == NotifyQuiet(from: "22:00", to: "07:00"))
        #expect(s.shown == [.telegram])
    }

    @Test func decodingIsStrictAboutWhatItReads() throws {
        let s = try decode(#"{"telegram":{"muted":"yes","finished":"sometimes","quiet":{"from":"7pm","to":"07:00"}},"channels":{"telegram":true}}"#)
        #expect(s.telegram == ChannelNotify())
        let none = try decode("{}")
        #expect(none.telegram == nil && none.shown.isEmpty)
        let same = try decode(#"{"cliq":{"quiet":{"from":"08:00","to":"08:00"}},"channels":{"cliq":true}}"#)
        #expect(same.cliq?.quiet == nil)
    }

    @Test func quietHoursFormatting() {
        let q = NotifyQuiet(from: "22:00", to: "07:05")
        #expect(q.summary() == "22:00 to 07:05")
        #expect(q.summary(twentyFourHour: false) == "10:00 PM to 7:05 AM")
        #expect(NotifyQuiet.display("00:30", false) == "12:30 AM")
        #expect(NotifyQuiet.display("12:00", false) == "12:00 PM")
        #expect(NotifyQuiet.clock(hour: 7, minute: 5) == "07:05")
    }

    @Test func quietHoursValidation() {
        #expect(NotifyQuiet.standard.isValid)
        #expect(!NotifyQuiet(from: "08:00", to: "08:00").isValid)
        #expect(!NotifyQuiet(from: "24:00", to: "01:00").isValid)
        #expect(!NotifyQuiet(from: "8:00", to: "09:00").isValid)
        #expect(NotifyQuiet.minutes("23:59") == 1439)
        #expect(!NotifyChange.quiet(NotifyQuiet(from: "08:00", to: "08:00")).isValid)
        #expect(NotifyChange.quiet(nil).isValid)
    }

    private func body(_ c: NotifyChange, _ ch: NotifyChannel = .telegram) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: c.requestBody(channel: ch)) as? [String: Any])
    }

    @Test func eachChangeIsOneKey() throws {
        let cases: [(NotifyChange, String)] = [
            (.muted(true), "muted"), (.approval(false), "approval"), (.question(true), "question"),
            (.stalled(false), "stalled"), (.quota(true), "quota"), (.finished(.off), "finished"),
            (.quiet(.standard), "quiet"), (.quiet(nil), "quiet"),
        ]
        for (change, key) in cases {
            let b = try body(change, .cliq)
            #expect(Set(b.keys) == ["channel", "change"])
            #expect(b["channel"] as? String == "cliq")
            let inner = try #require(b["change"] as? [String: Any])
            #expect(Array(inner.keys) == [key])
        }
        #expect((try body(.finished(.all))["change"] as? [String: Any])?["finished"] as? String == "all")
        #expect((try body(.quiet(nil))["change"] as? [String: Any])?["quiet"] is NSNull)
        let q = (try body(.quiet(.standard))["change"] as? [String: Any])?["quiet"] as? [String: String]
        #expect(q == ["from": "22:00", "to": "07:00"])
    }

    @Test func optimisticEditAndRollbackTouchOnlyThatKey() throws {
        var s = try decode(Self.wire)
        let undoopt = s.apply(.stalled(false), to: .telegram)
        let undo = try #require(undoopt)
        #expect(s.telegram?.stalled == false)
        // Another edit lands while the first is in flight.
        _ = s.apply(.quota(false), to: .telegram)
        s.rollback(undo, on: .telegram)
        #expect(s.telegram?.stalled == true)
        #expect(s.telegram?.quota == false)
        #expect(s.cliq?.stalled == true)
    }

    @Test func rollbackRestoresQuietAndFinished() throws {
        var s = try decode(Self.wire)
        let u1opt = s.apply(.quiet(.standard), to: .telegram)
        let u1 = try #require(u1opt)
        #expect(s.telegram?.quiet == .standard)
        s.rollback(u1, on: .telegram)
        #expect(s.telegram?.quiet == nil)
        let u2opt = s.apply(.finished(.off), to: .cliq)
        let u2 = try #require(u2opt)
        s.rollback(u2, on: .cliq)
        #expect(s.cliq?.finished == .off)
        let m = s.apply(.muted(true), to: .telegram)
        #expect(m != nil)
        var empty = NotifySettings()
        let none = empty.apply(.muted(true), to: .cliq)
        #expect(none == nil)
    }
}
