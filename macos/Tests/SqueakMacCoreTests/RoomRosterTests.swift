import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RoomRosterTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func ms(_ ago: TimeInterval) -> Int64 { Int64((now.timeIntervalSince1970 - ago) * 1000) }

    @Test func groupsOnDutyNewestFirstThenOffDuty() {
        let ducks = [
            PondDuck(id: "a", name: "Ada", lastActiveAt: ms(7200), createdAt: 1),
            PondDuck(id: "b", name: "Bo", duty: .off, lastActiveAt: ms(10)),
            PondDuck(id: "c", name: "Cy", lastActiveAt: ms(60)),
            PondDuck(id: "d", name: "Di", createdAt: ms(5)),
        ]
        let r = RoomRoster.roster(ducks, now: now)
        #expect(r.onDuty.map(\.id) == ["d", "c", "a"])
        #expect(r.offDuty.map(\.id) == ["b"])
        #expect(r.count == 4)
        #expect(RoomRoster.header(4) == "Ducks \u{00B7} 4" && RoomRoster.offDutyLabel(1) == "Off duty \u{00B7} 1")
    }

    @Test func tiesAreByNameThenId() {
        let r = RoomRoster.roster([PondDuck(id: "2", name: "zed"), PondDuck(id: "1", name: "Amy")], now: now)
        #expect(r.onDuty.map(\.name) == ["Amy", "zed"])
    }

    @Test func presenceText() {
        let session = "s1"
        let t = RoomThread(sessionId: session, title: "x", agent: "claude-code", state: .working, progress: RoomProgress(current: 3, total: 5))
        let working = RoomRoster.row(PondDuck(id: "a", name: "Ada", currentSessionId: session, state: .working), thread: t, now: now)
        #expect(working.presence == .working && working.presenceLine == "Working \u{00B7} 3 of 5" && working.agentLabel == "Claude")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", currentSessionId: session, state: .waiting), now: now).presenceLine == "Waiting on you")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", currentSessionId: session, lastActiveAt: ms(7200)), now: now).presenceLine == "Idle \u{00B7} 2h ago")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", duty: .off, currentSessionId: session, state: .working), now: now).presenceLine == "Off duty")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A"), now: now).presenceLine == "Ready for a job")
    }

    @Test func placeChip() {
        #expect(RoomRoster.placeChip(RoomPlace(workspaceId: "w", branch: "feat/login")) == "on feat/login")
        #expect(RoomRoster.placeChip(nil) == nil)
        #expect(RoomRoster.placeChip(RoomPlace(branch: " ")) == nil)
    }

    @Test func clickOpensOrSaysNoJob() {
        let none = RoomRoster.row(PondDuck(id: "a", name: "A"), now: now)
        #expect(RoomRoster.click(none) == .noJob(RoomRoster.noJobLine) && !none.hasJob)
        let has = RoomRoster.row(PondDuck(id: "a", name: "A", currentSessionId: "s"), now: now)
        #expect(RoomRoster.click(has) == .open(sessionId: "s"))
    }

    @Test func newDuckFormChecks() {
        #expect(NewDuckForm.validate(name: "  ", role: "") == .failure(.nameMissing))
        #expect(NewDuckForm.validate(name: String(repeating: "a", count: 33), role: "") == .failure(.nameTooLong))
        #expect(NewDuckForm.validate(name: String(repeating: "a", count: 32), role: "") == .success(.init(name: String(repeating: "a", count: 32), role: nil)))
        #expect(NewDuckForm.validate(name: "Ada", role: String(repeating: "r", count: 81)) == .failure(.roleTooLong))
        #expect(NewDuckForm.validate(name: " Ada ", role: " Layout ") == .success(.init(name: "Ada", role: "Layout")))
    }

    @Test func actionsMapToRequests() {
        let c = DuckAction.create(project: "p1", name: "Ada", role: "Layout").request
        #expect(c.method == "POST" && c.path == "/native/projects/p1/ducks" && c.body == .object(["name": .string("Ada"), "role": .string("Layout")]))
        #expect(DuckAction.create(project: "p1", name: "Ada", role: nil).request.body == .object(["name": .string("Ada")]))
        #expect(DuckAction.list(project: "p1").path == "/native/projects/p1/ducks")
        let r = DuckAction.rename(duck: "d1", name: "Bo").request
        #expect(r.method == "PATCH" && r.path == "/native/ducks/d1" && r.body == .object(["name": .string("Bo")]))
        #expect(DuckAction.setRole(duck: "d1", role: nil).request.body == .object(["role": .null]))
        let d = DuckAction.duty(duck: "d1", on: false).request
        #expect(d.method == "POST" && d.path == "/native/ducks/d1/duty" && d.body == .object(["on": .bool(false)]))
    }

    @Test func decodesLeniently() throws {
        let json = #"{"id":"d1","name":"Ada","colourSeed":"seed","duty":"off","state":"working","place":{"kind":"stream","workspaceId":"w","branch":"b"},"extra":1}"#
        let d = try JSONDecoder().decode(PondDuck.self, from: Data(json.utf8))
        #expect(d.colourSeed == "seed" && d.duty == .off && d.state == .working && d.place?.branch == "b" && d.currentSessionId == nil)
        let bare = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"x"}"#.utf8))
        #expect(bare.name == "Duck" && bare.colourSeed == "x" && bare.duty == .on)
    }

    @Test func fallbackFromThreadsAndUpsert() throws {
        let t = try JSONDecoder().decode(RoomThread.self, from: Data(#"{"sessionId":"s1","title":"T","duckId":"d9","colourSeed":"cs","place":{"kind":"stream","branch":"b"}}"#.utf8))
        let d = PondDuck(thread: t)
        #expect(d.id == "d9" && d.colourSeed == "cs" && d.currentSessionId == "s1" && d.place?.branch == "b")
        let old = PondDuck(thread: RoomThread(sessionId: "s2", title: "Old", state: .idle))
        #expect(old.id == "s2" && old.colourSeed == "s2")
        var l = [PondDuck(id: "a", name: "A")]
        l = RoomRoster.upserting(PondDuck(id: "a", name: "A2"), into: l)
        l = RoomRoster.upserting(PondDuck(id: "b", name: "B"), into: l)
        #expect(l.map(\.name) == ["A2", "B"])
        #expect(RoomRoster.jobMessage(duckName: "Ada", text: " fix it ") == "@Ada fix it" && RoomRoster.jobMessage(duckName: "Ada", text: " ") == nil)
    }
}
