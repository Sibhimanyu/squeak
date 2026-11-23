import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct InspectorTabsTests {
    @Test func pondStripAlwaysStartsWithPinnedPond() {
        let s = InspectorStrip.make(context: .pond)
        #expect(s.tabs == [.pond, .artifacts])  // Artifacts always beside Pond
        #expect(s.isPinned(.artifacts) && !s.isClosable(.artifacts))
        #expect(s.selected == .pond)
        #expect(s.isPinned(.pond) && !s.isClosable(.pond) && !s.isDraggable(.pond))
        #expect(RightTab.pond.title == "Pond" && RightTab.pond.symbol == "person.2")
    }

    @Test func pondStripListsOpenTabsThenShells() {
        let t1 = UUID(), t2 = UUID()
        var r = InspectorTabsRecord()
        r.open(.files); r.open(.code); r.open(.terminal)
        #expect(r.open == [.files, .code])
        let s = InspectorStrip.make(context: .pond, record: r, terminals: [t1, t2], selectedTerminal: t2)
        #expect(s.tabs == [.pond, .artifacts, .files, .code, .terminal(t1), .terminal(t2)])
        #expect(s.selected == .terminal(t2))
        #expect(s.isClosable(.files) && s.isClosable(.terminal(t1)))
    }

    @Test func selectionFallsBackToPondWhenTheTabIsGone() {
        let r = InspectorTabsRecord(open: [], selected: .code)
        #expect(InspectorStrip.make(context: .pond, record: r).selected == .pond)
        let t = InspectorTabsRecord(open: [], selected: .terminal)
        #expect(InspectorStrip.make(context: .pond, record: t).selected == .pond)
        let id = UUID()
        #expect(InspectorStrip.make(context: .pond, record: t, terminals: [id]).selected == .terminal(id))
    }

    @Test func closingFallsToTheLeftNeighbour() {
        var r = InspectorTabsRecord(open: [.files, .code], selected: .code)
        r.close(.code)
        #expect(r.selected == .files && r.open == [.files])
        r.close(.files)
        #expect(r.selected == .pond && r.open.isEmpty)
    }

    @Test func streamPinsTheFirstPanelNotAStashedOne() {
        let s = InspectorStrip.make(context: .stream(panels: [.code, .pond]), selectedPanel: .pond)
        #expect(s.pinned == .panel(.code))
        #expect(!s.isClosable(.panel(.code)) && s.isClosable(.panel(.pond)))
        #expect(s.selected == .panel(.pond))
        #expect(InspectorStrip.make(context: .stream(panels: [])).tabs == [.panel(.code), .artifacts])
        #expect(InspectorStrip.make(context: .stream(panels: [.terminal, .code])).pinned == .panel(.code))
    }

    @Test func streamShowsAShellWhenOneIsSelected() {
        let id = UUID()
        let s = InspectorStrip.make(context: .stream(panels: [.code]), terminals: [id], selectedTerminal: id)
        #expect(s.tabs == [.panel(.code), .artifacts, .terminal(id)] && s.selected == .terminal(id))
    }

    @Test func plusMenuAndDefault() {
        #expect(InspectorStrip.plusItems(context: .pond) == [.newTerminal, .files, .code])
        #expect(InspectorStrip.plusDefault == .newTerminal)
    }

    @Test func recordsPersistPerPondInTheLayout() throws {
        var l = DockLayout.standard
        var r = l.inspectorRecord(pond: "a")
        r.open(.files)
        l.setInspectorRecord(r, pond: "a")
        let back = try JSONDecoder().decode(DockLayout.self, from: JSONEncoder().encode(l))
        #expect(back.inspectorRecord(pond: "a") == r)
        #expect(back.inspectorRecord(pond: "b") == InspectorTabsRecord())
        l.setInspectorRecord(InspectorTabsRecord(), pond: "a")
        #expect(l.inspectorTabs.isEmpty)
    }

    @Test func oldLayoutsAndJunkDecode() throws {
        let old = try JSONDecoder().decode(DockLayout.self, from: Data(#"{"right":{"panels":["code"]}}"#.utf8))
        #expect(old.inspectorTabs.isEmpty)
        let junk = try JSONDecoder().decode(InspectorTabsRecord.self, from: Data(#"{"open":["files","files","pond","zzz","code"],"selected":"zzz"}"#.utf8))
        #expect(junk.open == [.files, .code] && junk.selected == .pond)
    }

    @Test func firstVisitSelectsPondLaterVisitsKeepThePick() {
        var v = InspectorVisits()
        let saved = InspectorTabsRecord(open: [.code], selected: .code)
        #expect(v.arrive(at: "a", record: saved) == InspectorTabsRecord(open: [.code], selected: .pond))
        #expect(v.arrive(at: "a", record: saved) == saved)
        #expect(v.arrive(at: "b", record: saved).selected == .pond)
    }

    @Test func commandTInTheRightZoneIsANewTerminal() {
        #expect(InspectorKeys.newTab(focusedZone: .right) == .newTerminal)
        #expect(InspectorKeys.newTab(focusedZone: .bottom) == .newThread)
        #expect(InspectorKeys.newTab(focusedZone: nil) == .newThread)
    }
}

@Suite struct InspectorArtifactsTabTests {
    @Test func artifactsIsAlwaysInThePondStrip() {
        var r = InspectorTabsRecord()
        r.open(.files); r.open(.artifacts)
        #expect(r.open == [.files, .artifacts] && r.selected == .artifacts)
        let s = InspectorStrip.make(context: .pond, record: r)
        #expect(s.tabs == [.pond, .artifacts, .files] && s.selected == .artifacts)
        #expect(!s.isClosable(.artifacts))
        #expect(RightTab.artifacts.title == "Artifacts" && RightTab.artifacts.kind == .artifacts)
        r.close(.artifacts)
        #expect(r.selected == .files)
    }

    @Test func remotePondAndOldSavesStayPeopleOnlyOrClean() throws {
        var r = InspectorTabsRecord(); r.open(.artifacts)
        #expect(InspectorStrip.make(context: .pond, record: r, peopleOnly: true).tabs == [.pond, .artifacts])
        let old = try JSONDecoder().decode(InspectorTabsRecord.self, from: Data(#"{"open":["files","bogus"],"selected":"artifacts"}"#.utf8))
        #expect(old.open == [.files] && old.selected == .artifacts)
        // Artifacts is always in the strip, so a saved Artifacts selection is kept.
        #expect(InspectorStrip.make(context: .pond, record: old).selected == .artifacts)
    }
}

@Suite struct StreamArtifactsTabTests {
    @Test func artifactsFollowsTheFirstPanelPinned() {
        let s = InspectorStrip.make(context: .stream(panels: [.code, .pond]))
        #expect(s.tabs == [.panel(.code), .artifacts, .panel(.pond)] && s.pinned == .panel(.code))
        #expect(s.isPinned(.artifacts) && !s.isClosable(.artifacts) && !s.isDraggable(.artifacts))
        #expect(s.isClosable(.panel(.pond)))
        // The first panel is a pond panel when it leads the zone: Artifacts still comes second.
        #expect(InspectorStrip.make(context: .stream(panels: [.pond, .code])).tabs == [.panel(.pond), .artifacts, .panel(.code)])
    }

    @Test func artifactsCanBeTheShownTabButAShellWinsAndPeopleOnlyHasIt() {
        let id = UUID()
        #expect(InspectorStrip.make(context: .stream(panels: [.code]), artifactsSelected: true).selected == .artifacts)
        #expect(InspectorStrip.make(context: .stream(panels: [.code]), terminals: [id], selectedTerminal: id, artifactsSelected: true).selected == .terminal(id))
        #expect(InspectorStrip.make(context: .stream(panels: [.code])).selected == .panel(.code))
        let remote = InspectorStrip.make(context: .stream(panels: [.code]), artifactsSelected: true, peopleOnly: true)
        #expect(remote.tabs == [.panel(.code), .artifacts] && remote.selected == .artifacts)
    }
}

@Suite struct HomeInspectorTabsTests {
    @Test func dashboardWithNoShellIsJustThePlus() {
        let s = InspectorStrip.make(context: .home)
        #expect(s.tabs.isEmpty && s.selected == nil && s.pinned == nil)
        #expect(InspectorStrip.plusItems(context: .home) == [.newTerminal])
    }

    @Test func dashboardListsOnlyShellsAndTheyAllClose() {
        let a = UUID(), b = UUID()
        let s = InspectorStrip.make(context: .home, terminals: [a, b])
        #expect(s.tabs == [.terminal(a), .terminal(b)] && s.selected == .terminal(a))
        #expect(s.isClosable(.terminal(a)) && s.isDraggable(.terminal(b)))
        #expect(!s.tabs.contains(.pond) && !s.tabs.contains(.artifacts) && !s.tabs.contains(.code))
        #expect(InspectorStrip.make(context: .home, terminals: [a, b], selectedTerminal: b).selected == .terminal(b))
        #expect(InspectorStrip.make(context: .home, terminals: [a], selectedTerminal: b).selected == .terminal(a))
    }

    @Test func pondAndStreamStripsKeepTheirPinnedFirstTab() {
        #expect(InspectorStrip.make(context: .pond).pinned == .pond)
        #expect(InspectorStrip.make(context: .pond).tabs == [.pond, .artifacts])
        #expect(InspectorStrip.make(context: .stream(panels: [.code])).tabs == [.panel(.code), .artifacts])
        #expect(InspectorStrip.make(context: .stream(panels: [.code])).pinned == .panel(.code))
    }
}
