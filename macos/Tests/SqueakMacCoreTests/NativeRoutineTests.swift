import Foundation
import Testing
@testable import SqueakMacCore

struct NativeRoutineTests {
    @Test func aDraftSendsTheHostsScheduleShapes() {
        var d = NativeRoutineDraft()
        d.prompt = "Check CI"; d.model = "opus"
        #expect(d.isValid)
        guard case .object(let o) = d.json, case .object(let daily)? = o["schedule"] else { Issue.record("shape"); return }
        #expect(daily == ["kind": .string("daily"), "at": .string("09:00")])
        d.kind = "weekly"; d.day = 1; d.at = "08:30"
        guard case .object(let w) = d.json, case .object(let weekly)? = w["schedule"] else { Issue.record("shape"); return }
        #expect(weekly == ["kind": .string("weekly"), "day": .number(1), "at": .string("08:30")])
        d.kind = "daily"; d.at = "25:00"
        #expect(!d.isValid)
        d.kind = "hourly"; d.every = 0
        #expect(!d.isValid)
    }

    @Test func schedulesReadAsWords() throws {
        let json = #"{"id":"r","title":"t","prompt":"p","schedule":{"kind":"weekly","day":1,"at":"08:00"},"agent":"claude","model":"m","enabled":true,"newWorkspace":true}"#
        let r = try JSONDecoder().decode(NativeRoutine.self, from: Data(json.utf8))
        #expect(r.scheduleWords == "Mondays at 08:00")
        var h = r; h.schedule = .init(kind: "hourly", every: 6)
        #expect(h.scheduleWords == "Every 6 hours")
    }
}
