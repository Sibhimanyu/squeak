import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct CallHistoryTests {
    private func view(_ json: String) throws -> CallsView {
        try JSONDecoder().decode(CallsView.self, from: Data(json.utf8))
    }

    @Test func decodesEveryOutcome() throws {
        for o in ["answered", "unanswered", "failed", "moved_on"] {
            let v = try view(#"{"calls":[{"id":"a","at":1000,"kind":"agent","outcome":"\#(o)","durationMs":5000}],"gatewayLog":null}"#)
            #expect(v.calls.first?.outcome.rawValue == o)
        }
        let v = try view(#"{"calls":[{"id":"a","at":1,"kind":"test","outcome":"answered","letter":"2","sent":true,"durationMs":42000,"reason":"blocked_approval","label":"x"}],"gatewayLog":{"at":5,"lines":[{"at":1,"level":"warn","text":"slow"},{"at":2,"level":"info","text":"ok"}]}}"#)
        #expect(v.calls[0].kind == .test && v.calls[0].letter == "2" && v.calls[0].sent == true)
        #expect(v.gatewayLog?.lines.map(\.level) == [.warn, .info])
    }

    @Test func toleratesUnknownAndMissing() throws {
        let v = try view(#"{"calls":[{"id":"a","at":1,"kind":"x","outcome":"mystery"},{}],"gatewayLog":{"lines":[{"level":"loud","text":"t"}]}}"#)
        #expect(v.calls[0].kind == .agent && v.calls[0].outcome == .unanswered && v.calls[0].durationMs == 0)
        #expect(v.calls.count == 2)
        #expect(v.gatewayLog?.lines.first?.level == .info)
        let empty = try view("{}")
        #expect(empty.calls.isEmpty && empty.gatewayLog == nil)
    }

    @Test func outcomeSentences() {
        func e(_ o: CallOutcome, letter: String? = nil, sent: Bool? = nil, failure: String? = nil) -> CallEntry {
            CallEntry(id: "i", at: 0, outcome: o, letter: letter, sent: sent, failure: failure)
        }
        #expect(CallText.outcomeSentence(e(.answered, letter: "2", sent: true)) == "Answered, pressed 2 · sent")
        #expect(CallText.outcomeSentence(e(.unanswered)) == "Not answered")
        #expect(CallText.outcomeSentence(e(.failed, failure: "no route")) == "Could not be placed: no route")
        #expect(CallText.outcomeSentence(e(.movedOn)) == "Answered, but the chat had moved on")
    }

    @Test func durations() {
        #expect(CallText.duration(ms: 42_000) == "42 s")
        #expect(CallText.duration(ms: 72_000) == "1 min 12 s")
        #expect(CallText.duration(ms: 180_000) == "3 min")
        #expect(CallText.duration(ms: -5) == "0 s")
    }

    private var cal: Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c
    }

    @Test func relativeTimes() {
        let now = Date(timeIntervalSince1970: 1_700_000_000) // 2023-11-14 22:13 UTC
        func ms(_ s: String) -> Double {
            let f = ISO8601DateFormatter(); return f.date(from: s)!.timeIntervalSince1970 * 1000
        }
        #expect(CallText.when(ms: ms("2023-11-14T14:02:00Z"), now: now, calendar: cal) == "Today 14:02")
        #expect(CallText.when(ms: ms("2023-11-13T09:15:00Z"), now: now, calendar: cal) == "Yesterday 09:15")
        #expect(CallText.when(ms: ms("2023-11-10T09:15:00Z"), now: now, calendar: cal) == "Fri 10 Nov 09:15")
    }

    @Test func exports() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let c = CallEntry(id: "a", at: 1_699_970_520_000, kind: .test, outcome: .unanswered, durationMs: 30_000)
        #expect(CallText.callsExport([c], now: now, calendar: cal) == "Today 14:02 · Test call · Not answered · 30 s")
        let log = GatewayLog(at: 1, lines: [GatewayLogLine(at: 1_699_970_520_000, level: .warn, text: "slow speech")])
        #expect(CallText.logExport(log, calendar: cal) == "14:02:00 WARN slow speech")
    }
}
