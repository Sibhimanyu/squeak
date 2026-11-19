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

    private func visible(_ l: DockLayout, enabled: Bool? = nil) -> Bool {
        InspectorStash.rightVisible(l, files: DockFiles(), terminals: DockTerminals(), enabled: enabled)
    }

    @Test func eachInspectorHasItsOwnFlag() {
        #expect(InspectorStash.roomEnabled && InspectorStash.pondEnabled && !InspectorStash.threadEnabled)
        #expect(InspectorStash.hides(.thread) && !InspectorStash.hides(.pond))
        #expect(!InspectorStash.hides(.thread, enabled: true))
        #expect(InspectorStash.hides(.pond, enabled: false))
    }

    @Test func aStashedThreadInspectorAloneLeavesNoRightZone() {
        var l = DockLayout.standard
        l.close(.code)
        l.close(.pond)
        #expect(l.right.panels == [.thread])
        #expect(!visible(l))
        #expect(visible(l, enabled: true))
        #expect(visible(DockLayout.standard))  // the Pond panel is shown
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

@Suite("Pond drag: following the fingers, committing, the hint")
struct PondDragTests {
    /// Steps are (dx, dy, seconds since the last event); the gesture starts at t = 1.
    private func run(_ steps: [(Double, Double, Double)], current: PondPage = .dashboard, width: Double = 1000, end: Bool = true, rest: Double = 0) -> [PondDrag.Update] {
        var d = PondDrag(); var out: [PondDrag.Update] = []; var t = 1.0
        out += d.feed(dx: 0, dy: 0, phase: .began, momentum: false, current: current, width: width, time: t).map { [$0] } ?? []
        for s in steps {
            t += s.2
            out += d.feed(dx: s.0, dy: s.1, phase: .changed, momentum: false, current: current, width: width, time: t).map { [$0] } ?? []
        }
        if end { out += d.feed(dx: 0, dy: 0, phase: .ended, momentum: false, current: current, width: width, time: t + rest).map { [$0] } ?? [] }
        return out
    }

    @Test func tracksOneToOneAndRubberBandsPastTheEnds() {
        #expect(PondDrag.position(origin: 0, delta: -100, width: 1000) == 0.1)
        #expect(PondDrag.position(origin: 1, delta: 250, width: 1000) == 0.75)
        // Past the Room: gives less than the fingers and never more than the share.
        let past = PondDrag.position(origin: 1, delta: -100, width: 1000)
        #expect(past > 1 && past < 1.1)
        #expect(PondDrag.position(origin: 1, delta: -100000, width: 1000) < 1 + PondDrag.rubberShare)
        #expect(PondDrag.position(origin: 0, delta: 100, width: 1000) < 0)
        #expect(PondDrag.position(origin: 0, delta: 100, width: 1000) > -0.1)
    }

    @Test func travelProgressAndPageEdges() {
        #expect(PondDrag.travel(position: 0.15, page: .dashboard) == 0.15)
        #expect(PondDrag.travel(position: -0.05, page: .dashboard) == 0)
        #expect(abs(PondDrag.travel(position: 0.85, page: .room) - 0.15) < 1e-9)
        #expect(abs(PondDrag.progress(position: 0.15, page: .dashboard) - 0.5) < 1e-9)
        #expect(PondDrag.progress(position: 0.9, page: .dashboard) == 1)
        #expect(PondDrag.x(of: .room, position: 0, width: 1000) == 1000)
        #expect(PondDrag.x(of: .dashboard, position: 0.25, width: 1000) == -250)
        #expect(PondDrag.x(of: .room, position: 0.25, width: 1000) == 750)
    }

    @Test func slowDragPastThirtyPercentCommitsOnEndNotBefore() {
        // 4 x 80 pt, 0.2 s apart: no flick, 32% of 1000.
        let out = run([(-80, 0, 0.2), (-80, 0, 0.2), (-80, 0, 0.2), (-80, 0, 0.2)], rest: 0.3)
        #expect(out.last == .commit(.room, from: 0.32, velocity: 0))
        #expect(!out.dropLast().contains { if case .commit = $0 { true } else { false } })
        #expect(out.first == .track(0.08))
    }

    @Test func slowDragShortOfThirtyPercentSettles() {
        let out = run([(-100, 0, 0.2), (-100, 0, 0.2)], rest: 0.3)
        #expect(out.last == .settle(from: 0.2, velocity: 0))
    }

    @Test func aFlickCommitsEvenWhenShort() {
        // 90 pt in 60 ms = 1500 pt/s, only 9% of the width.
        let out = run([(-30, 0, 0.02), (-30, 0, 0.02), (-30, 0, 0.02)])
        guard case .commit(let page, let from, let v)? = out.last else { Issue.record("no commit"); return }
        #expect(page == .room && abs(from - 0.09) < 1e-9 && v > 1000)
    }

    @Test func aFlickTheOtherWayDoesNotCommit() {
        // Dragged right (toward nothing on the Dashboard) with a fast snap back left: no commit to the Room from a flick that
        // ended behind the start.
        let out = run([(60, 0, 0.02), (-30, 0, 0.02), (-30, 0, 0.02)])
        #expect(!out.contains { if case .commit = $0 { true } else { false } })
    }

    @Test func fingersRestingBeforeLiftingIsNotAFlick() {
        let out = run([(-30, 0, 0.02), (-30, 0, 0.02), (-30, 0, 0.02)], rest: 0.3)
        #expect(out.last == .settle(from: 0.09, velocity: 0))
    }

    @Test func rightFingersGoToDashboardAndTargetShownIsNothing() {
        let room = run([(120, 0, 0.1), (120, 0, 0.1), (120, 0, 0.1)], current: .room, rest: 0.3)
        guard case .commit(let page, _, _)? = room.last else { Issue.record("no commit"); return }
        #expect(page == .dashboard)
        // Dashboard and fingers right: it rubber-bands, then settles.
        let dash = run([(300, 0, 0.1)], current: .dashboard, rest: 0.3)
        #expect(dash.last.map { if case .settle = $0 { true } else { false } } == true)
    }

    @Test func aGrabbedFinishContinuesFromWhereItWas() {
        var d = PondDrag()
        _ = d.feed(dx: 0, dy: 0, phase: .began, momentum: false, current: .room, width: 1000, time: 1, origin: 0.7)
        let u = d.feed(dx: 100, dy: 0, phase: .changed, momentum: false, current: .room, width: 1000, time: 1.1, origin: 0.7)
        #expect(u == .track(0.6))
    }

    @Test func verticalScrollSettlesAndNeverCommits() {
        let out = run([(-10, 0, 0.02), (-5, 40, 0.02), (-100, 10, 0.02)])
        #expect(out.contains { if case .settle = $0 { true } else { false } })
        #expect(!out.contains { if case .commit = $0 { true } else { false } })
    }

    @Test func momentumIsIgnored() {
        var d = PondDrag()
        #expect(d.feed(dx: -300, dy: 0, phase: .changed, momentum: true, current: .dashboard, width: 1000) == nil)
    }
}

@Suite("Swipe feel: velocity, commit, finish, ring, haptic, hint")
struct SwipeFeelTests {
    @Test func velocityUsesTheLastEightyMilliseconds() {
        let samples = [SwipeSample(t: 0, x: 0), SwipeSample(t: 0.5, x: -10), SwipeSample(t: 0.54, x: -40), SwipeSample(t: 0.58, x: -80)]
        // Only the last two samples are inside 80 ms of 0.58 (0.5 is exactly 80 ms back): 70 pt in 80 ms.
        let v = SwipeVelocity.estimate(samples)
        #expect(v < -800 && v > -1000)
        #expect(SwipeVelocity.estimate([SwipeSample(t: 0, x: 0)]) == 0)
        #expect(SwipeVelocity.estimate([]) == 0)
        // Rested before lifting.
        #expect(SwipeVelocity.estimate(samples, now: 0.9) == 0)
    }

    @Test func commitByDistanceOrFlick() {
        #expect(SwipeCommit.commits(travelShare: 0.31, velocityToward: 0, travel: 310))
        #expect(!SwipeCommit.commits(travelShare: 0.29, velocityToward: 0, travel: 290))
        #expect(SwipeCommit.commits(travelShare: 0.08, velocityToward: 700, travel: 80))
        #expect(!SwipeCommit.commits(travelShare: 0.08, velocityToward: 500, travel: 80))
        #expect(!SwipeCommit.commits(travelShare: 0.08, velocityToward: -900, travel: 80))
        #expect(!SwipeCommit.commits(travelShare: 0.01, velocityToward: 900, travel: 10))
    }

    @Test func finishDurationScalesWithRemainingDistance() {
        let near = SwipeFinish.commitDuration(remainingShare: 0.1, width: 1000, velocity: 0)
        let far = SwipeFinish.commitDuration(remainingShare: 0.9, width: 1000, velocity: 0)
        #expect(near < far)
        #expect(SwipeFinish.commitRange.contains(near) && SwipeFinish.commitRange.contains(far))
        #expect(far <= 0.35 && near >= 0.18)
        // A fast flick finishes sooner than the distance alone says.
        #expect(SwipeFinish.commitDuration(remainingShare: 0.9, width: 1000, velocity: 4000) < far)
        #expect(SwipeFinish.settleDuration(remainingShare: 0.5, width: 1000, velocity: 0) < SwipeFinish.commitDuration(remainingShare: 0.5, width: 1000, velocity: 0))
        #expect(SwipeFinish.settleRange.contains(SwipeFinish.settleDuration(remainingShare: 1, width: 1000, velocity: 0)))
    }

    @Test func curveDecelerates() {
        #expect(SwipeCurve.value(0) == 0 && SwipeCurve.value(1) == 1)
        #expect(SwipeCurve.value(0.25) > 0.5)
        #expect(SwipeCurve.value(0.5) < SwipeCurve.value(0.75))
    }

    @Test func ringFillsToTheCommitPoint() {
        #expect(SwipeRing.trim(progress: 0.4) == 0.4)
        #expect(SwipeRing.trim(progress: 1.7) == 1 && SwipeRing.trim(progress: -1) == 0)
        #expect(!SwipeRing.flipped(progress: 0.99) && SwipeRing.flipped(progress: 1))
    }

    @Test func hapticFiresOncePerGesture() {
        var h = SwipeHapticLatch()
        let early = h.crosses(progress: 0.5), first = h.crosses(progress: 1), again = h.crosses(progress: 1)
        let back = h.crosses(progress: 0.2), cross2 = h.crosses(progress: 1)
        #expect(!early && first && !again && !back && !cross2)
        h.reset()
        let afterReset = h.crosses(progress: 1)
        #expect(afterReset)
    }

    @Test func peekIsFirstVisitOnly() {
        #expect(PondSwipeHint(visits: 1).peeks(reduceMotion: false))
        #expect(!PondSwipeHint(visits: 2).peeks(reduceMotion: false))
        #expect(!PondSwipeHint(visits: 1, swipes: 1).peeks(reduceMotion: false))
        #expect(!PondSwipeHint(visits: 1).peeks(reduceMotion: true))
        #expect(PondSwipeHint.peekPosition(page: .dashboard, width: 1000) == 0.028)
        #expect(PondSwipeHint.peekPosition(page: .room, width: 1000) == 0.972)
    }

    @Test func wordHidesAfterThreeSwipesAndTheButtonQuietens() {
        #expect(PondSwipeHint(swipes: 2).showsWord)
        #expect(!PondSwipeHint(swipes: 3).showsWord)
        #expect(PondSwipeHint(swipes: 0).restingOpacity > PondSwipeHint(swipes: 3).restingOpacity)
    }
}

@Suite struct SwipeGestureGateTests {
    @Test func decidesOncePerGesture() {
        var gate = SwipeGestureGate()
        var asked = 0
        func ask(_ answer: Bool) -> () -> Bool { { asked += 1; return answer } }
        do { let b = gate.blocked(begins: true, standalone: false, lookup: ask(true)); #expect(b) }
        for _ in 0..<50 { let b = gate.blocked(begins: false, standalone: false, lookup: ask(false)); #expect(b) }
        #expect(asked == 1)
        // The next gesture decides again.
        do { let b = gate.blocked(begins: true, standalone: false, lookup: ask(false)); #expect(!b) }
        do { let b = gate.blocked(begins: false, standalone: false, lookup: ask(true)); #expect(!b) }
        #expect(asked == 2)
    }

    @Test func aGestureJoinedMidwayDecidesOnItsFirstEvent() {
        var gate = SwipeGestureGate()
        do { let b = gate.blocked(begins: false, standalone: false, lookup: { false }); #expect(!b) }
        do { let b = gate.blocked(begins: false, standalone: false, lookup: { true }); #expect(!b) }
        #expect(gate.lookups == 1)
    }

    @Test func aPhaselessWheelIsAskedEachTime() {
        var gate = SwipeGestureGate()
        _ = gate.blocked(begins: false, standalone: true, lookup: { false })
        _ = gate.blocked(begins: false, standalone: true, lookup: { false })
        #expect(gate.lookups == 2 && gate.decided == nil)
    }

    // MARK: Axis lock

    private func feedAll(_ d: inout PondDrag, _ steps: [(Double, Double, PondSwipe.Phase, Bool)]) -> [PondDrag.Update] {
        var out: [PondDrag.Update] = []; var t = 1.0
        for (dx, dy, ph, mom) in steps {
            t += 0.008
            if let u = d.feed(dx: dx, dy: dy, phase: ph, momentum: mom, current: .dashboard, width: 1000, time: t) { out.append(u) }
        }
        return out
    }

    @Test func aVerticalGestureProducesNothingAtAll() {
        var d = PondDrag()
        var steps: [(Double, Double, PondSwipe.Phase, Bool)] = [(0, 0, .began, false)]
        for i in 0..<40 { steps.append((i % 3 == 0 ? 3 : 0, 9, .changed, false)) }
        steps.append((0, 0, .ended, false))
        #expect(feedAll(&d, steps).isEmpty)
    }

    @Test func momentumAfterAVerticalGestureIsIgnored() {
        var d = PondDrag()
        let out = feedAll(&d, [(0, 0, .began, false), (1, 12, .changed, false), (0, 0, .ended, false),
                               (30, 5, .none, true), (40, 2, .none, true)])
        #expect(out.isEmpty)
    }

    @Test func aHorizontalGestureStillTracks() {
        var d = PondDrag()
        let out = feedAll(&d, [(0, 0, .began, false), (-10, 1, .changed, false), (-20, 1, .changed, false)])
        #expect(out.count == 2 && out.allSatisfy { if case .track = $0 { true } else { false } })
    }

    @Test func aDiagonalStartResolvesOnce() {
        var axis = SwipeAxis()
        #expect(axis.resolve(x: 2, y: 2) == .undecided)
        #expect(axis.resolve(x: 3, y: 5) == .vertical)
        // Later travel never flips the decision.
        #expect(axis.resolve(x: 400, y: 5) == .vertical)
        var h = SwipeAxis()
        #expect(h.resolve(x: 5, y: 3) == .horizontal)
        #expect(h.resolve(x: 5, y: 900) == .horizontal)
    }
}
