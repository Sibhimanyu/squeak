import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ActivationRulesTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func anOpenWindowIsAlwaysRegular() {
        #expect(ActivationRules.wantsRegular(hasWindow: true, showRequestedAt: nil, lastCloseAt: now, now: now))
    }

    @Test func aRequestedWindowStaysRegularWhileItAppears() {
        let asked = now.addingTimeInterval(-1)
        #expect(ActivationRules.wantsRegular(hasWindow: false, showRequestedAt: asked, lastCloseAt: nil, now: now))
        #expect(!ActivationRules.wantsRegular(
            hasWindow: false, showRequestedAt: now.addingTimeInterval(-4), lastCloseAt: nil, now: now))
    }

    /// The bug: opened from the popover and closed within three seconds, a late check still saw the request,
    /// turned regular again, opened Squeak through Launch Services, and that reopen brought the window back.
    @Test func aCloseAfterTheRequestEndsTheWait() {
        let asked = now.addingTimeInterval(-1.5)
        let closed = now.addingTimeInterval(-0.5)
        #expect(!ActivationRules.wantsRegular(hasWindow: false, showRequestedAt: asked, lastCloseAt: closed, now: now))
    }

    /// Welcome closes, then the conversation window is asked for: the newer request still counts.
    @Test func aRequestAfterACloseStillCounts() {
        let closed = now.addingTimeInterval(-0.5)
        let asked = now.addingTimeInterval(-0.4)
        #expect(ActivationRules.wantsRegular(hasWindow: false, showRequestedAt: asked, lastCloseAt: closed, now: now))
    }

    /// The bug: opened from Finder, Squeak was already the active accessory and Finder's menus stayed.
    @Test func activeAsAccessoryStepsOutAndBack() {
        #expect(ActivationRules.menuBarRoute(wasActiveAsAccessory: true) == .deactivateThenReopen)
        #expect(ActivationRules.menuBarRoute(wasActiveAsAccessory: false) == .activate)
    }

    @Test func noSelfOpenWithoutAWindow() {
        #expect(ActivationRules.shouldReopenSelf(menuBarIsOurs: false, windowShownOrPending: true))
        #expect(!ActivationRules.shouldReopenSelf(menuBarIsOurs: false, windowShownOrPending: false))
        #expect(!ActivationRules.shouldReopenSelf(menuBarIsOurs: true, windowShownOrPending: true))
    }

    @Test func theEchoOfASelfOpenReopensNothing() {
        #expect(ReopenPolicy.action(hasOrdinaryWindow: false, selfOpenAt: now.addingTimeInterval(-1), now: now) == .none)
        #expect(ReopenPolicy.action(hasOrdinaryWindow: false, selfOpenAt: now.addingTimeInterval(-10), now: now)
            == .showConversation)
        #expect(ReopenPolicy.action(hasOrdinaryWindow: false, selfOpenAt: nil, now: now) == .showConversation)
    }
}
