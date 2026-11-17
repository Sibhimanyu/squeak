import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Pond flow: swipe, back and click targets")
struct PondFlowTests {
    // MARK: Swipe

    /// Feeds a gesture of `steps` events of (dx, dy) each, with began first and ended last; returns every decision.
    private func gesture(_ swipe: inout PondSwipe, dx: Double, dy: Double = 0, steps: Int, current: PondPage, momentum: Int = 0) -> [PondPage] {
        var out: [PondPage] = []
        for i in 0..<steps {
            if let p = swipe.feed(dx: dx, dy: dy, phase: i == 0 ? .began : .changed, momentum: false, current: current) { out.append(p) }
        }
        if let p = swipe.feed(dx: 0, dy: 0, phase: .ended, momentum: false, current: current) { out.append(p) }
        for _ in 0..<momentum { if let p = swipe.feed(dx: dx, dy: dy, phase: .none, momentum: true, current: current) { out.append(p) } }
        return out
    }

    @Test func fingersLeftShowTheRoomAndRightShowTheDashboard() {
        var s = PondSwipe()
        #expect(gesture(&s, dx: -20, steps: 6, current: .dashboard) == [.room])
        #expect(gesture(&s, dx: 20, steps: 6, current: .room) == [.dashboard])
    }

    @Test func oneSwitchPerGestureEvenWithMomentum() {
        var s = PondSwipe()
        #expect(gesture(&s, dx: -30, steps: 20, current: .dashboard, momentum: 30) == [.room])
    }

    @Test func momentumAloneNeverSwitches() {
        var s = PondSwipe()
        for _ in 0..<40 { #expect(s.feed(dx: -50, dy: 0, phase: .none, momentum: true, current: .dashboard) == nil) }
        // A mouse wheel has no phase.
        #expect(s.feed(dx: -500, dy: 0, phase: .none, momentum: false, current: .dashboard) == nil)
    }

    @Test func belowTheThresholdNothingHappensAndTheNextGestureStartsFresh() {
        var s = PondSwipe()
        #expect(gesture(&s, dx: -5, steps: 5, current: .dashboard).isEmpty)
        #expect(gesture(&s, dx: -5, steps: 5, current: .dashboard).isEmpty)
        #expect(gesture(&s, dx: -20, steps: 5, current: .dashboard) == [.room])
    }

    @Test func aVerticalScrollIsNotASwipe() {
        var s = PondSwipe()
        #expect(gesture(&s, dx: -4, dy: 30, steps: 20, current: .dashboard).isEmpty)
        // Even if it drifts sideways later in the same gesture.
        var t = PondSwipe()
        _ = t.feed(dx: 0, dy: 60, phase: .began, momentum: false, current: .dashboard)
        #expect(t.feed(dx: -300, dy: 0, phase: .changed, momentum: false, current: .dashboard) == nil)
    }

    @Test func aSwipeTowardsThePageAlreadyShownDoesNothingButUsesUpTheGesture() {
        var s = PondSwipe()
        #expect(gesture(&s, dx: -30, steps: 6, current: .room).isEmpty)
    }

    @Test func aGestureCancelledMidwayForgetsItsTravel() {
        var s = PondSwipe()
        _ = s.feed(dx: -50, dy: 0, phase: .began, momentum: false, current: .dashboard)
        _ = s.feed(dx: 0, dy: 0, phase: .cancelled, momentum: false, current: .dashboard)
        #expect(s.feed(dx: -50, dy: 0, phase: .began, momentum: false, current: .dashboard) == nil)
    }

    // MARK: Origin

    @Test func closingTheLastTabOpenedFromAPondGoesBackToTheViewItCameFrom() {
        var o = PondOriginStack()
        o.opened(tab: "a", pond: "squeak", page: .room)
        o.opened(tab: "b", pond: "squeak", page: .room)
        #expect(o.closed(tab: "a") == nil)
        #expect(o.closed(tab: "b") == .init(pond: "squeak", page: .room))
        #expect(o.origin == nil)
        #expect(o.closed(tab: "b") == nil)
    }

    @Test func theDashboardIsRememberedToo() {
        var o = PondOriginStack()
        o.opened(tab: "a", pond: "squeak", page: .dashboard)
        #expect(o.closed(tab: "a") == .init(pond: "squeak", page: .dashboard))
    }

    @Test func aTabNotOpenedFromThePondChangesNothing() {
        var o = PondOriginStack()
        o.opened(tab: "a", pond: "squeak", page: .room)
        #expect(o.closed(tab: "other") == nil)
        #expect(o.has(tab: "a"))
    }

    @Test func openingFromAnotherPondOrOpeningAPondClearsIt() {
        var o = PondOriginStack()
        o.opened(tab: "a", pond: "squeak", page: .room)
        o.opened(tab: "b", pond: "blume", page: .dashboard)
        #expect(o.closed(tab: "a") == nil)
        #expect(o.closed(tab: "b") == .init(pond: "blume", page: .dashboard))
        o.opened(tab: "c", pond: "blume", page: .room)
        o.pondOpened("squeak")
        #expect(o.origin == nil && o.tabs.isEmpty)
        o.opened(tab: "d", pond: "squeak", page: .room)
        o.pondOpened("squeak")
        #expect(o.has(tab: "d"))
        o.clear()
        #expect(o.closed(tab: "d") == nil)
    }

    @Test func theLatestViewIsTheOneComeBackTo() {
        var o = PondOriginStack()
        o.opened(tab: "a", pond: "squeak", page: .room)
        o.opened(tab: "b", pond: "squeak", page: .dashboard)
        _ = o.closed(tab: "a")
        #expect(o.closed(tab: "b")?.page == .dashboard)
    }

    // MARK: Click targets

    private func message(_ author: RoomMessageAuthor, goesTo: String? = nil, parts: [RoomPart] = [.text("hi", .normal)]) -> RoomMessage {
        var m = RoomMessage(id: "m", at: 0, author: author, parts: parts)
        m.goesTo = goesTo
        return m
    }
    private let duck = RoomMessageAuthor(kind: .duck, key: "d:s1", name: "Marlow", sessionId: "s1")

    @Test func aDucksEverythingOpensThatDuck() {
        let m = message(duck, parts: [.text("done", .normal), .chip(sessionId: "s1", text: "2 files")])
        #expect(PondClick.target(message: m) == .duck("s1"))
        #expect(PondClick.target(part: m.parts[1], in: m) == .duck("s1"))
        #expect(PondClick.target(author: duck, goesTo: nil) == .duck("s1"))
    }

    @Test func aPersonOpensTheDuckTheirMessageWentToAndNothingWhenNone() {
        #expect(PondClick.target(message: message(.me, goesTo: "s2")) == .duck("s2"))
        #expect(PondClick.target(message: message(.person("Ana"), goesTo: "s3")) == .duck("s3"))
        #expect(PondClick.target(message: message(.me)) == nil)
    }

    @Test func ducklingsOpenTheDucksDucklingTabs() {
        let set = RoomDucklings(count: 2, done: 0, items: [RoomDuckling(label: "Probe"), RoomDuckling(label: "Fix")])
        let m = message(duck, parts: [.ducklings(set)])
        #expect(PondClick.target(part: m.parts[0], in: m) == .ducklings(duck: "s1", labels: ["Probe", "Fix"]))
        #expect(PondClick.target(duckling: set.items[1], of: "s1") == .ducklings(duck: "s1", labels: ["Fix"]))
        #expect(PondOpenTarget.ducklings(duck: "s1", labels: []).duck == "s1")
    }

    @Test func aHandoffLineAndAJobOpenTheDuckItWentTo() {
        let line = RoomSystemLine(id: "x", at: 0, text: "a handed off to b", jobId: nil, buttons: [], opens: "s2")
        #expect(PondClick.target(line: line) == .duck("s2"))
        #expect(PondClick.target(line: RoomSystemLine(id: "y", at: 0, text: "quiet", jobId: nil, buttons: [])) == nil)
        let job = RoomJob(id: "j", messageId: "p1", text: "t", status: .handed, handedTo: RoomJobHandedTo(sessionId: "s4", title: "T"))
        #expect(PondClick.target(job: job) == .duck("s4"))
    }

    @Test func aPersonsTurnMessageRecordsTheDuckItWentTo() {
        var f = RoomFeed()
        let turn = RoomTurn(id: "s1:1", sessionId: "s1", threadTitle: "T", agent: "claude", startedAt: 1_780_000_000_000, endedAt: 1_780_000_100_000, outcome: .finished,
                            prompt: "fix it", author: RoomTurnAuthor(name: "Sibhi", me: true), outcomeText: "ok")
        f.apply(page: RoomPage(posts: [], latestSeq: 0, threads: [], turns: [turn], jobs: []))
        let items = RoomMessages.build(feed: f)
        let mine = items.compactMap { if case .group(let g) = $0 { g } else { nil } }.flatMap(\.messages).first { $0.author.kind == .me }
        #expect(mine?.goesTo == "s1")
    }

    // MARK: Inspector stash

    private func visible(_ l: DockLayout, enabled: Bool = false) -> Bool {
        InspectorStash.rightVisible(l, files: DockFiles(), terminals: DockTerminals(), enabled: enabled)
    }

    @Test func stashedInspectorsAloneLeaveNoRightZone() {
        var l = DockLayout.standard
        l.close(.code)
        #expect(l.right.panels == [.thread, .pond])
        #expect(!visible(l))
        #expect(visible(l, enabled: true))
        #expect(InspectorStash.hides(.thread) && InspectorStash.hides(.pond))
        #expect(!InspectorStash.hides(.thread, enabled: true))
    }

    @Test func otherPanelsKeepTheRightZone() {
        var l = DockLayout.standard
        l.move(.pond, to: .right)
        l.move(.code, to: .right)
        #expect(visible(l))
        var t = DockLayout.standard
        t.move(.terminal, to: .right)
        #expect(visible(t))
        #expect(!InspectorStash.hides(.code) && !InspectorStash.hides(.terminal))
    }
}
