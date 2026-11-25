import Foundation
import Testing

@testable import SqueakMacCore

@Suite("Pond swipe: spring, settle, switch indicator")
struct PondSwipeSpringTests {
    @Test func theSpringStartsAtTheFingersAndEndsOnThePage() {
        let s = SwipeSpring(from: 0.4, target: 1, velocity: 0)
        #expect(abs(s.position(at: 0) - 0.4) < 1e-9)
        #expect(abs(s.position(at: s.duration) - 1) < 0.001)
        #expect(s.duration > 0.1 && s.duration < 0.8)
    }

    @Test func theSpringContinuesTheFingersSpeedNotARestart() {
        let s = SwipeSpring(from: 0.3, target: 1, velocity: 2)
        #expect(abs(s.speed(at: 0) - 2) < 0.05)
        let slow = SwipeSpring(from: 0.3, target: 1, velocity: 0)
        #expect(s.position(at: 0.05) > slow.position(at: 0.05))
    }

    @Test func criticalDampingNeverOvershootsAFlick() {
        let s = SwipeSpring(from: 0.2, target: 1, velocity: 6)
        var t = 0.0
        while t < 1 { #expect(s.position(at: t) <= 1 + 1e-9); t += 1.0 / 240 }
    }

    @Test func everyDampingRegimeSettlesOnItsTarget() {
        for z in [0.8, 1.0, 1.6] {
            let s = SwipeSpring(from: 1.1, target: 1, velocity: -0.4, damping: z)
            #expect(abs(s.position(at: s.duration) - 1) < 0.001, "damping \(z)")
        }
    }

    @Test func settlesByDistanceOrByVelocity() {
        // Past 30% of the width commits; short of it falls back; a flick commits even when short; a flick the wrong way does not.
        #expect(SwipeSettle.page(from: .dashboard, position: 0.35, velocity: 0, width: 1000) == .room)
        #expect(SwipeSettle.page(from: .dashboard, position: 0.2, velocity: 0, width: 1000) == .dashboard)
        #expect(SwipeSettle.page(from: .dashboard, position: 0.1, velocity: 1.5, width: 1000) == .room)
        #expect(SwipeSettle.page(from: .dashboard, position: 0.1, velocity: -1.5, width: 1000) == .dashboard)
        #expect(SwipeSettle.page(from: .room, position: 0.65, velocity: 0, width: 1000) == .dashboard)
        #expect(SwipeSettle.page(from: .room, position: 0.9, velocity: -1.5, width: 1000) == .dashboard)
        #expect(SwipeSettle.page(from: .room, position: 0.9, velocity: 0, width: 1000) == .room)
    }

    @Test func theStartingVelocityPointsTowardThePageItSettlesOn() {
        #expect(SwipeSettle.velocity(pointsPerSecond: 800, width: 1000, from: 0.3, to: 1) == 0.8)
        #expect(SwipeSettle.velocity(pointsPerSecond: 800, width: 1000, from: 0.7, to: 0) == -0.8)
        #expect(SwipeSettle.velocity(pointsPerSecond: 800, width: 0, from: 0.3, to: 1) == 0)
    }

    @Test func theSwitchPillFollowsTheSelectionAtRestAndTheStripWhileMoving() {
        #expect(PondSwitchIndicator.progress(selection: .dashboard, strip: nil) == 0)
        #expect(PondSwitchIndicator.progress(selection: .room, strip: nil) == 1)
        #expect(PondSwitchIndicator.progress(selection: .dashboard, strip: 0.5) == 0.5)
        // A rubber band stays on the track.
        #expect(PondSwitchIndicator.progress(selection: .room, strip: 1.08) == 1)
        #expect(PondSwitchIndicator.progress(selection: .dashboard, strip: -0.08) == 0)
        // A Duck or an item covers the pages: no pill, whatever the strip says.
        #expect(PondSwitchIndicator.progress(selection: nil, strip: 0.5) == nil)
    }

    @Test func thePillInterpolatesBetweenTheSegmentsAndLabelsFollow() {
        let d = (x: 2.0, width: 80.0), r = (x: 84.0, width: 50.0)
        #expect(PondSwitchIndicator.pill(progress: 0, dashboard: d, room: r) == d)
        #expect(PondSwitchIndicator.pill(progress: 1, dashboard: d, room: r) == r)
        let mid = PondSwitchIndicator.pill(progress: 0.5, dashboard: d, room: r)
        #expect(mid.x == 43 && mid.width == 65)
        #expect(PondSwitchIndicator.weight(of: .dashboard, progress: 0) == 1)
        #expect(PondSwitchIndicator.weight(of: .room, progress: 0.5) == 0.5)
        #expect(PondSwitchIndicator.weight(of: .room, progress: 0) == 0)
    }

    @Test func everyEntryPointLeavesTheSwitchOnThePageThatShows() {
        let notebook = TabItem(.notebook, "n")
        // Swipe commit, a cancelled swipe (no event reaches the centre), then a switch click.
        var c = PondCentre(page: .dashboard)
        c.swipe(to: .room)
        #expect(c.switchSelection == .room && PondSwitchIndicator.progress(selection: c.switchSelection, strip: nil) == 1)
        let cancelled = c
        #expect(cancelled.switchSelection == .room)
        c.switchTo(.dashboard); #expect(c.switchSelection == .dashboard)
        // Esc from the Room, a deep link and the way back from the Duck, a pond reopen from the remembered page.
        c.switchTo(.room); c.escape(); #expect(c.switchSelection == .dashboard)
        c.switchTo(.room); c.deepLink(duck: "d"); #expect(c.switchSelection == nil)
        c.escape(); #expect(c.switchSelection == .room)
        let reopened = PondCentre(page: c.page); #expect(reopened.switchSelection == .room && reopened.stripPage == .room)
        // An item over the Room hides the pill; closing it brings the same page back.
        var item = PondCentre(page: .room, item: notebook); #expect(item.switchSelection == nil)
        item.escape(); #expect(item.switchSelection == .room)
        // Opening a Duck from the Room and coming back by the switch lands on the page picked.
        var duck = PondCentre(page: .room); duck.selectDuck("d"); duck.switchTo(.dashboard)
        #expect(duck.switchSelection == .dashboard && duck.effects(from: PondCentre(page: .room, duck: "d")).leaveDuck)
    }

    @Test func theScrimAndStackingFollowThePageThatMoves() {
        #expect(PondStripPlan.scrim(x: 0, width: 800) == 0)
        #expect(PondStripPlan.scrim(x: 0.4, width: 800) == 0)
        #expect(PondStripPlan.scrim(x: 800, width: 800) == 0.28)
        #expect(PondStripPlan.scrim(x: -400, width: 800) == 0.14)
        #expect(PondStripPlan.zPosition(of: .room, rest: .dashboard) > PondStripPlan.zPosition(of: .dashboard, rest: .dashboard))
        #expect(PondStripPlan.zPosition(of: .dashboard, rest: .room) > PondStripPlan.zPosition(of: .room, rest: .room))
    }

    @Test func aFrameOfPolicyWorkIsFarUnderABudget() {
        // Spring step + progress + weights per frame; the view's own cost is what the signposts measure.
        let s = SwipeSpring(from: 0.3, target: 1, velocity: 1)
        let start = Date()
        var sink = 0.0
        for i in 0..<10_000 {
            let p = s.position(at: Double(i % 60) / 120)
            sink += PondSwitchIndicator.progress(selection: .dashboard, strip: p) ?? 0
            sink += PondSwitchIndicator.weight(of: .room, progress: p)
        }
        let perFrame = Date().timeIntervalSince(start) / 10_000
        #expect(sink > 0)
        #expect(perFrame < 0.0005, "policy per frame \(perFrame * 1e6) us")
    }
}
