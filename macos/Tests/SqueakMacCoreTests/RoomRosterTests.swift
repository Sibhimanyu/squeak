import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RoomRosterTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func ms(_ ago: TimeInterval) -> Int64 { Int64((now.timeIntervalSince1970 - ago) * 1000) }

    @Test func groupsOpenNewestFirstThenClosed() {
        let ducks = [
            PondDuck(id: "a", name: "Ada", lastActiveAt: ms(7200), createdAt: 1),
            PondDuck(id: "b", name: "Bo", isOpen: false, lastActiveAt: ms(10)),
            PondDuck(id: "c", name: "Cy", lastActiveAt: ms(60)),
            PondDuck(id: "d", name: "Di", createdAt: ms(5)),
        ]
        let r = RoomRoster.roster(ducks, now: now)
        #expect(r.open.map(\.id) == ["d", "c", "a"])
        #expect(r.closed.map(\.id) == ["b"])
        #expect(r.count == 4)
        #expect(RoomRoster.header(4) == "Ducks \u{00B7} 4" && RoomRoster.closedLabel(1) == "Closed \u{00B7} 1")
    }

    @Test func defaultListIsAvailableOnlyAndSearchCoversEveryDuck() {
        let ducks = [
            PondDuck(id: "a", name: "Ada", role: "Layout builder", lastActiveAt: ms(7200)),
            PondDuck(id: "b", name: "Bo", role: "Tester", isOpen: false, lastActiveAt: ms(10), chatTitle: "Bo tester run"),
            PondDuck(id: "c", name: "Cy\u{00E9}", lastActiveAt: ms(60)),
            PondDuck(id: "d", name: "Old Dan", role: "layout reviewer", isOpen: false, lastActiveAt: 1),
        ]
        #expect(RoomRoster.visible(ducks, query: "", now: now).map(\.id) == ["c", "a"])
        #expect(RoomRoster.visible(ducks, query: "   ", now: now).map(\.id) == ["c", "a"])
        // by name (open) or chat title (closed, which wears no name), greyed (open false)
        let bo = RoomRoster.visible(ducks, query: "bo", now: now)
        #expect(bo.map(\.id) == ["b"] && bo[0].isOpen == false)
        // by role; Available first, then closed; case-insensitive
        #expect(RoomRoster.visible(ducks, query: "LAYOUT", now: now).map(\.id) == ["a", "d"])
        #expect(RoomRoster.visible(ducks, query: "layout rev", now: now).map(\.id) == ["d"])
        #expect(RoomRoster.visible(ducks, query: "cye", now: now).map(\.id) == ["c"])
        #expect(RoomRoster.visible(ducks, query: "zzz", now: now).isEmpty)
        #expect(RoomRoster.noMatchLine(" zzz ") == "No duck called \u{201C}zzz\u{201D}")
    }

    @Test func bringBackPutsTheDuckInTheDefaultList() {
        var ducks = [PondDuck(id: "a", name: "Ada"), PondDuck(id: "b", name: "Bo", isOpen: false)]
        #expect(RoomRoster.visible(ducks, query: "", now: now).map(\.id) == ["a"])
        ducks = RoomRoster.upserting(PondDuck(id: "b", name: "Bo", isOpen: true), into: ducks)
        #expect(Set(RoomRoster.visible(ducks, query: "", now: now).map(\.id)) == ["a", "b"])
        #expect(DuckAction.setOpen(duck: "b", open: true).request.path == "/native/ducks/b/state")
        #expect(RoomRoster.header(RoomRoster.roster(ducks, now: now).available.count) == "Ducks \u{00B7} 2")
    }

    @Test func tiesAreByNameThenId() {
        let r = RoomRoster.roster([PondDuck(id: "2", name: "zed"), PondDuck(id: "1", name: "Amy")], now: now)
        #expect(r.open.map(\.name) == ["Amy", "zed"])
    }

    @Test func presenceText() {
        let session = "s1"
        let t = RoomThread(sessionId: session, title: "x", agent: "claude-code", state: .working, progress: RoomProgress(current: 3, total: 5))
        let working = RoomRoster.row(PondDuck(id: "a", name: "Ada", currentSessionId: session, state: .working), thread: t, now: now)
        #expect(working.presence == .working && working.presenceLine == "Working \u{00B7} 3 of 5" && working.agentLabel == "Claude")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", currentSessionId: session, state: .waiting), now: now).presenceLine == "Waiting on you")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", currentSessionId: session, lastActiveAt: ms(7200)), now: now).presenceLine == "Idle \u{00B7} 2h ago")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", isOpen: false, currentSessionId: session, state: .working), now: now).presenceLine == "Closed")
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A"), now: now).presenceLine == "Ready for a job")
    }

    @Test func streamLabelsAreTheHostsOrPond() {
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A"), now: now).streamLabels == ["Pond"])
        #expect(RoomRoster.row(PondDuck(id: "a", name: "A", streams: [RoomStream(workspaceId: "w", branch: "feat/login")]), now: now).streamLabels == ["feat/login"])
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
        let d = DuckAction.setOpen(duck: "d1", open: false).request
        #expect(d.method == "POST" && d.path == "/native/ducks/d1/state" && d.body == .object(["open": .bool(false)]))
    }

    @Test func decodesLeniently() throws {
        let json = #"{"id":"d1","name":"Ada","colourSeed":"seed","open":false,"state":"working","extra":1}"#
        let d = try JSONDecoder().decode(PondDuck.self, from: Data(json.utf8))
        #expect(d.colourSeed == "seed" && d.isOpen == false && d.state == .working && d.activity == .working && d.currentSessionId == nil)
        let bare = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"x"}"#.utf8))
        #expect(bare.name == "Duck" && bare.colourSeed == "x" && bare.isOpen)
    }

    @Test func anOlderDaemonsDutyKeyStillDecodes() throws {
        let off = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"d1","duty":"off"}"#.utf8))
        let on = try JSONDecoder().decode(PondDuck.self, from: Data(#"{"id":"d2","duty":"on"}"#.utf8))
        #expect(off.isOpen == false && on.isOpen)
        let thread = try JSONDecoder().decode(RoomThread.self, from: Data(#"{"sessionId":"s","duty":"off"}"#.utf8))
        #expect(thread.isOpen == false)
    }

    @Test func upsertsByDuckId() throws {
        var l = [PondDuck(id: "a", name: "A")]
        l = RoomRoster.upserting(PondDuck(id: "a", name: "A2"), into: l)
        l = RoomRoster.upserting(PondDuck(id: "b", name: "B"), into: l)
        #expect(l.map(\.name) == ["A2", "B"])
        #expect(RoomRoster.jobMessage(duckName: "Ada", text: " fix it ") == "@Ada fix it" && RoomRoster.jobMessage(duckName: "Ada", text: " ") == nil)
    }
}

@Suite struct PondInspectorSectionsTests {
    @Test func orderIsNeedsYouDucksPeople() {
        #expect(PondInspectorSections.sections(needsYou: 2, ducks: 3) == [.needsYou, .ducks, .people])
        #expect(PondInspectorSections.sections(needsYou: 0, ducks: 3) == [.ducks, .people])
    }

    @Test func emptySectionsHide() {
        #expect(PondInspectorSections.sections(needsYou: 0, ducks: 0, canAddDuck: false) == [.people])
        #expect(PondInspectorSections.sections(needsYou: 0, ducks: 0) == [.ducks, .people])
    }

    @Test func needsYouRows() {
        let ask = RoomAsk(question: "\n Use Postgres or SQLite?\nMore detail")
        let threads = [
            RoomThread(sessionId: "a", title: "A", state: .waiting, ask: ask, name: "Ada", lastActiveAt: 10),
            RoomThread(sessionId: "b", title: "B", state: .waiting, name: "Bo", lastActiveAt: 20),
            RoomThread(sessionId: "c", title: "C", state: .working),
            RoomThread(sessionId: "d", title: "D", state: .waiting, isOpen: false),
        ]
        let rows = PondInspectorSections.needsYou(threads)
        #expect(rows.map(\.sessionId) == ["b", "a"])
        #expect(rows[0].text == "wants approval" && rows[1].text == "asks: Use Postgres or SQLite?")
        #expect(rows[1].name == "Ada")
        #expect(PondInspectorSections.needsYou([]).isEmpty)
    }
}

@Suite struct SettingsPondsTests {
    private func pond(_ id: String, _ name: String, _ at: String?) -> PondDirectory.Pond {
        PondDirectory.Pond(id: id, name: name, lastActivityAt: at)
    }

    @Test func newestActivityFirstThenNone() {
        let l = SettingsPonds.ordered([
            pond("a", "Alpha", "2026-11-01T10:00:00Z"), pond("c", "Cedar", nil),
            pond("b", "Beta", "2026-11-05T10:00:00.500Z"), pond("d", "Birch", nil),
        ])
        #expect(l.map(\.id) == ["b", "a", "d", "c"])
    }

    @Test func selectionKeepsRequestedElseFirst() {
        let l = SettingsPonds.ordered([pond("a", "A", "2026-11-01T10:00:00Z"), pond("b", "B", "2026-11-05T10:00:00Z")])
        #expect(SettingsPonds.selection(requested: "a", in: l) == "a")
        #expect(SettingsPonds.selection(requested: "gone", in: l) == "b")
        #expect(SettingsPonds.selection(requested: nil, in: l) == "b")
        #expect(SettingsPonds.selection(requested: "a", in: []) == nil)
    }

    @Test func deepLinkRoute() {
        #expect(SettingsRoute.pond("k") == SettingsRoute(section: .ponds, pond: "k"))
        #expect(SettingsSection(link: "pond") == .ponds && SettingsSection.titledGroups.flatMap(\.sections).contains(.ponds))
    }
}
