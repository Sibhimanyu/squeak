import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct DuckModeTests {
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: id) }
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func chat(_ id: String, duck: String? = nil, branch: String? = nil, cwd: String? = nil, ago: Double, title: String = "", archived: Bool = false) -> HostSession {
        var s = HostSession(key: key(id), title: title.isEmpty ? id : title, branch: branch, cwd: cwd, lastActivityAt: t0.addingTimeInterval(-ago),
                            archivedAt: archived ? t0 : nil)
        s.duckId = duck
        return s
    }
    private let main = MainPlace(projectId: "p", pondName: "Pond", rootPath: "/repo", branch: "main")

    @Test func ducksAreNewestFirstOneRowPerDuck() {
        let rows = DuckList.rows([
            chat("a1", duck: "A", branch: "x", ago: 500), chat("b", duck: "B", branch: "y", ago: 10),
            chat("a2", duck: "A", branch: "x", ago: 100), chat("c", branch: "z", ago: 300),
        ], main: nil)
        #expect(rows.map(\.session.key.hostSessionId) == ["b", "a2", "c"])
    }

    @Test func archivedChatsAreNotDucks() {
        let rows = DuckList.rows([chat("a", duck: "A", ago: 10, archived: true), chat("b", duck: "B", ago: 20)], main: nil)
        #expect(rows.map(\.session.key.hostSessionId) == ["b"])
    }

    @Test func mainIsTheRootFolderAndLabelsAsMain() {
        let rows = DuckList.rows([chat("m", duck: "M", branch: "main", cwd: "/repo", ago: 1), chat("f", duck: "F", branch: "feat/x", cwd: "/wt/f", ago: 2)], main: main)
        #expect(rows[0].isMain && rows[0].label == "main" && rows[0].branch == nil)
        #expect(!rows[1].isMain && rows[1].label == "feat/x")
    }

    @Test func groupsByBranchNewestGroupFirst() {
        let rows = DuckList.rows([
            chat("a", duck: "A", branch: "x", cwd: "/wt/x", ago: 100), chat("b", duck: "B", branch: "y", cwd: "/wt/y", ago: 5),
            chat("c", duck: "C", branch: "x", cwd: "/wt/x", ago: 50), chat("m", duck: "M", cwd: "/repo", ago: 200),
        ], main: main)
        let groups = DuckList.groups(rows)
        #expect(groups.map(\.label) == ["y", "x", "main"])
        #expect(groups[1].rows.map(\.session.key.hostSessionId) == ["c", "a"])
        let branches = DuckList.branches(rows)
        #expect(branches.map(\.duckCount) == [1, 2, 1])
        #expect(branches[1].lead?.key.hostSessionId == "c")
    }

    @Test func workWithListsOtherDucksThenBranchesNeverMainOrSelf() {
        let rows = DuckList.rows([
            chat("me", duck: "ME", branch: "mine", cwd: "/wt/mine", ago: 1), chat("o", duck: "O", branch: "other", cwd: "/wt/o", ago: 2, title: "Login"),
            chat("o2", duck: "O2", branch: "other", cwd: "/wt/o", ago: 3), chat("m", duck: "M", cwd: "/repo", ago: 4),
        ], main: main)
        let t = DuckList.joinTargets(rows, excluding: key("me"))
        #expect(t.map(\.id) == ["duck:O", "duck:O2", "branch:other"])
        #expect(t[0].place == .join(duckId: "O"))
        #expect(t[2].place == .joinBranch("other"))
    }

    @Test func headerChromeMainBranchRemote() {
        #expect(DuckHeaderChrome.of(branch: nil, isMain: true, membership: .owner) == DuckHeaderChrome(chip: "main \u{00B7} read-only", readOnly: true, showsCreatePR: false))
        #expect(DuckHeaderChrome.of(branch: "feat/x", isMain: false, membership: .owner) == DuckHeaderChrome(chip: "feat/x", readOnly: false, showsCreatePR: true))
        #expect(DuckHeaderChrome.of(branch: "feat/x", isMain: false, membership: .remote) == DuckHeaderChrome(chip: nil, readOnly: false, showsCreatePR: false))
        #expect(DuckHeaderChrome.of(branch: nil, isMain: false, membership: .owner).chip == nil)
    }

    @Test func tabPlanIsThePondsDucksWithOpenChatAlwaysThere() {
        let rows = DuckList.rows([chat("a", duck: "A", ago: 1), chat("b", duck: "B", ago: 2)], main: nil)
        let plan = DuckTabPlan.plan(location: .chat(key("n")), previous: key("a").stringValue, ducks: rows)
        #expect(plan.entries == [.thread(key("a").stringValue), .thread(key("n").stringValue), .thread(key("b").stringValue)])
        #expect(plan.selected == .thread(key("n").stringValue))
    }

    @Test func collapseKeepsSavedOrderAndShowsEachDucksNewestChat() {
        let old = chat("a1", duck: "A", ago: 500), new = chat("a2", duck: "A", ago: 5), b = chat("b", duck: "B", ago: 50)
        let out = DuckList.collapse([old, b, new])
        #expect(out.map(\.key.hostSessionId) == ["a2", "b"])
    }

    @Test func movingADuckReplacesItsTabInPlace() {
        var tabs = StreamTabs()
        tabs.open(.thread("a"), in: "w"); tabs.open(.thread("b"), in: "w"); tabs.open(.thread("c"), in: "w")
        tabs.select(.thread("b"), in: "w")
        let r1 = tabs.replace(.thread("b"), with: .thread("b2"), in: "w")
        #expect(r1)
        #expect(tabs.tabs("w") == [.thread("a"), .thread("b2"), .thread("c")])
        #expect(tabs.selected("w") == .thread("b2"))
        // Replacing with a tab already open just drops the old one.
        let r2 = tabs.replace(.thread("a"), with: .thread("c"), in: "w")
        #expect(r2)
        #expect(tabs.tabs("w") == [.thread("b2"), .thread("c")])
    }

    @Test func placeBodies() {
        #expect(DuckPlace.main.json == .object(["kind": .string("main")]))
        #expect(DuckPlace.new(branch: nil).json == .object(["kind": .string("new")]))
        #expect(DuckPlace.new(branch: " fix ").json == .object(["kind": .string("new"), "branch": .string("fix")]))
        #expect(DuckPlace.join(duckId: "d").json == .object(["kind": .string("join"), "duckId": .string("d")]))
        #expect(DuckPlace.joinBranch("b").json == .object(["kind": .string("join"), "branch": .string("b")]))
    }

    @Test func directoryFlagAbsentIsOff() throws {
        let off = try JSONDecoder().decode(PondDirectory.self, from: Data(#"{"schema":1,"ponds":[]}"#.utf8))
        #expect(!off.ducksMode)
        let on = try JSONDecoder().decode(PondDirectory.self, from: Data(#"{"schema":1,"ponds":[],"ducksOwnBranch":true}"#.utf8))
        #expect(on.ducksMode)
    }

    @Test func ducksModeFoldsStreamsAndMainIntoOnePondRow() {
        let sessions = [chat("a", duck: "A", branch: "x", cwd: "/wt/x", ago: 10), chat("m", duck: "M", cwd: "/repo", ago: 20)]
        var a = sessions[0]; a.repoName = "pond"; var m = sessions[1]; m.repoName = "pond"
        let flat = SidebarTreeBuilder.build([a, m], now: t0, mains: [main], ducksMode: true)
        #expect(flat.projects.count == 1 && flat.projects[0].workspaces.count == 1)
        let w = flat.projects[0].workspaces[0]
        #expect(w.isDucks && !w.isMain && w.chats.count == 2)
        let off = SidebarTreeBuilder.build([a, m], now: t0, mains: [main])
        #expect(off.projects[0].workspaces.count == 2)
    }

    @Test func focusCarriesTheDucksBranch() {
        let k = key("a")
        let f = WorkbenchFocus.resolve(.chat(k), place: { _ in ChatPlace(pond: "p", workspace: "w", branch: "feat/x") })
        #expect(f.branch == "feat/x" && f.workspace == "w")
        #expect(WorkbenchFocus.resolve(.chat(k), place: { _ in ChatPlace(pond: "p", workspace: "w") }).branch == nil)
    }

    @Test func groupPrefsPerPond() {
        var raw = ""
        raw = DuckGroupPrefs.toggled(raw, pond: "p1")
        raw = DuckGroupPrefs.toggled(raw, pond: "p2")
        #expect(DuckGroupPrefs.contains(raw, pond: "p1") && DuckGroupPrefs.contains(raw, pond: "p2"))
        raw = DuckGroupPrefs.toggled(raw, pond: "p1")
        #expect(!DuckGroupPrefs.contains(raw, pond: "p1") && DuckGroupPrefs.contains(raw, pond: "p2"))
    }

    /// Live shape (2026-11-22): the host's /native/sessions carries duckId and branch; the daemon's /state does not carry duckId.
    @Test func duckIdAndBranchComeFromTheHostList() throws {
        let host = #"{"id":"d7d89252-31b6-4f65-9c77-74f46c6ea5aa","workspaceId":"87d08ded","cwd":"/x/hong-kong","agent":"claude","title":"Rebuild and Improve Website Content","status":"idle","branch":"rethink-presence","duckId":"b661a98c-97be-4b39-8a02-4287efbf2c10"}"#
        let ns = try JSONDecoder().decode(NativeSession.self, from: Data(host.utf8))
        let h = NativeAdapter.map(ns, overlay: nil)
        #expect(h.duckId == "b661a98c-97be-4b39-8a02-4287efbf2c10")
        #expect(h.branch == "rethink-presence")
        let old = try JSONDecoder().decode(NativeSession.self, from: Data(#"{"id":"a","status":"idle"}"#.utf8))
        #expect(NativeAdapter.map(old, overlay: nil).duckId == nil)
    }

    @Test func ducksModeNeverShowsMainOnAnyPath() {
        // Every opening path in ducks mode reads the ducks line: pond context, fixed branch, shortcut with Main known.
        for fixed in [false, true] {
            for pond in [false, true] {
                #expect(NewChatIn.placeLine(ducksFlag: true, conductorWorkspace: false, fixedPlace: fixed, hasPond: pond, ownerMac: false, hasMain: true) == .ducks)
            }
        }
        // The old regression: a pond context with Main known fell through to "In: Main".
        #expect(NewChatIn.placeLine(ducksFlag: true, conductorWorkspace: false, fixedPlace: false, hasPond: true, ownerMac: false, hasMain: true) != .inMain)
    }

    @Test func nonDucksPlaceLineIsUnchanged() {
        #expect(NewChatIn.placeLine(ducksFlag: false, conductorWorkspace: false, fixedPlace: false, hasPond: false, ownerMac: false, hasMain: true) == .inMain)
        #expect(NewChatIn.placeLine(ducksFlag: false, conductorWorkspace: false, fixedPlace: false, hasPond: true, ownerMac: false, hasMain: false) == .pond)
        #expect(NewChatIn.placeLine(ducksFlag: false, conductorWorkspace: false, fixedPlace: true, hasPond: false, ownerMac: false, hasMain: false) == .fixed)
        #expect(NewChatIn.placeLine(ducksFlag: false, conductorWorkspace: true, fixedPlace: true, hasPond: false, ownerMac: false, hasMain: true) == .fixed)
        #expect(NewChatIn.placeLine(ducksFlag: false, conductorWorkspace: false, fixedPlace: false, hasPond: false, ownerMac: false, hasMain: false) == .picker)
    }

    @Test func plusInADucksChatJoinsThatDuck() {
        #expect(DuckList.plusPlace(for: chat("a", duck: "D1", branch: "rethink-presence", cwd: "/wt/a", ago: 1), main: main) == .join(duckId: "D1"))
        #expect(DuckList.plusPlace(for: chat("b", branch: "rethink-presence", cwd: "/wt/b", ago: 1), main: main) == .joinBranch("rethink-presence"))
        #expect(DuckList.plusPlace(for: chat("m", duck: "M", branch: "main", cwd: "/repo", ago: 1), main: main) == nil)
        #expect(DuckList.plusPlace(for: chat("n", ago: 1), main: main) == nil)
    }
}

@Suite struct PondRowCountTests {
    @Test func ducksModeShowsOnDutyNotTreeChats() {
        let c = PondCounts(onDuty: 2, working: 1, needsYou: 0, offDuty: 3, total: 5)
        #expect(PondRowCount.of(ducksMode: true, counts: c, treeChats: 0, listed: 0) == 2)
        #expect(PondRowCount.of(ducksMode: true, counts: PondCounts(onDuty: 0, working: 0, needsYou: 0, offDuty: 4, total: 4), treeChats: 3, listed: 3) == 0)
    }
    @Test func ducksModeWithoutCountsFallsBack() {
        #expect(PondRowCount.of(ducksMode: true, counts: nil, treeChats: 1, listed: 4) == 4)
    }
    @Test func flagOffIgnoresCounts() {
        let c = PondCounts(onDuty: 9, working: 0, needsYou: 0, offDuty: 0, total: 9)
        #expect(PondRowCount.of(ducksMode: false, counts: c, treeChats: 5, listed: 2) == 5)
    }
}
