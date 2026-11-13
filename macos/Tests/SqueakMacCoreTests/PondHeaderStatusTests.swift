import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondHeaderStatusTests {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func aBackgroundReadStaysQuietUntilItIsSlow() {
        var tracker = PondReadTracker()
        tracker.begin("a", byPerson: false, now: t0)
        #expect(tracker.isReading("a") && !tracker.isShown("a", now: t0))
        #expect(!tracker.isShown("a", now: t0.addingTimeInterval(0.9)))
        #expect(tracker.isShown("a", now: t0.addingTimeInterval(1.1)))
        #expect(tracker.showsAt("a") == t0.addingTimeInterval(1))
        tracker.end("a")
        #expect(!tracker.isReading("a") && !tracker.isShown("a", now: t0.addingTimeInterval(5)))
    }

    @Test func aReadThePersonStartedShowsAtOnceAndAPollDoesNotDowngradeIt() {
        var tracker = PondReadTracker()
        tracker.begin("a", byPerson: true, now: t0)
        #expect(tracker.isShown("a", now: t0) && tracker.showsAt("a") == nil)
        tracker.begin("a", byPerson: false, now: t0.addingTimeInterval(3))
        #expect(tracker.reads["a"]?.since == t0 && tracker.isShown("a", now: t0))
    }

    @Test func aQuietReadBecomesPersonalWhenThePersonAsksToo() {
        var tracker = PondReadTracker()
        tracker.begin("a", byPerson: false, now: t0)
        tracker.begin("a", byPerson: true, now: t0.addingTimeInterval(0.2))
        #expect(tracker.isShown("a", now: t0.addingTimeInterval(0.2)))
    }

    @Test func theNoRemoteFactIsAFixedLineWithAnInfoSentenceNotARow() {
        let s = PondHeaderStatus.make(access: "Owner \u{00B7} 2 people", local: false, offer: .shareOnly(why: PondStartThread.noRemote), freshness: .live, readShown: false)
        #expect(s.accessLine == PondHeaderStatus.shareOnlyLine && s.info == PondStartThread.noRemote && s.indicator == .none)
        let ok = PondHeaderStatus.make(access: "Owner \u{00B7} 2 people", local: false, offer: .start, freshness: .live, readShown: false)
        #expect(ok.accessLine == "Owner \u{00B7} 2 people" && ok.info == nil)
        // A local pond is only on this Mac: the sentence about sharing does not apply.
        let local = PondHeaderStatus.make(access: "Only on this Mac", local: true, offer: .shareOnly(why: "x"), freshness: .live, readShown: false)
        #expect(local.accessLine == "Only on this Mac" && local.info == nil)
    }

    @Test func refreshingShowsOnlyWhenTheReadIsShown() {
        #expect(PondHeaderStatus.make(access: "a", local: false, offer: nil, freshness: .refreshing, readShown: false).indicator == .none)
        #expect(PondHeaderStatus.make(access: "a", local: false, offer: nil, freshness: .refreshing, readShown: true).indicator == .refreshing)
        #expect(PondHeaderStatus.make(access: "a", local: false, offer: nil, freshness: .reading, readShown: false).indicator == .none)
    }

    @Test func problemsAreAlwaysInTheSlotWithTheirWordsOnHover() {
        let stale = PondHeaderStatus.make(access: "a", local: false, offer: nil, freshness: .stale, readShown: false)
        guard case .problem(let help) = stale.indicator else { Issue.record("not a problem"); return }
        #expect(help.contains("Can\u{2019}t reach the pond right now"))
        guard case .retry = PondHeaderStatus.make(access: "a", local: false, offer: nil, freshness: .couldntRead, readShown: false).indicator else { Issue.record("no retry"); return }
    }
}
