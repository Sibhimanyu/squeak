import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Setup tips")
struct SetupTipsTests {
    var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "UTC")!
        return c
    }
    let day0 = Date(timeIntervalSince1970: 1_800_000_000)
    func later(_ days: Double = 0, hours: Double = 0) -> Date { day0.addingTimeInterval(days * 86_400 + hours * 3_600) }

    func calls(wait: TimeInterval = 20 * 60) -> TipFacts {
        TipFacts(phoneOrTelegramSetUp: true, longestQuestionWait: wait)
    }

    @Test func nothingDueShowsNothing() {
        var h = TipHistory()
        #expect(h.tipToShow(facts: TipFacts(), now: day0, calendar: calendar) == nil)
    }

    @Test func neverDuringFirstRun() {
        var h = TipHistory()
        var f = calls()
        f.firstRunActive = true
        #expect(h.tipToShow(facts: f, now: day0, calendar: calendar) == nil)
        #expect(h.lastStartedAt == nil)
        f.firstRunActive = false
        #expect(h.tipToShow(facts: f, now: day0, calendar: calendar) == .phoneCalls)
    }

    // MARK: Triggers

    @Test func keepAwakeRightAfterAPairingAndOnlyForAWhile() {
        var h = TipHistory()
        h.observeChannels([], now: day0)
        h.observeChannels(["phone-1"], now: day0)
        #expect(h.tipToShow(facts: TipFacts(), now: later(hours: 1), calendar: calendar) == .keepAwake)
        var late = h
        late.current = nil
        late.lastStartedAt = nil
        #expect(late.tipToShow(facts: TipFacts(), now: later(4), calendar: calendar) == nil)
    }

    @Test func keepAwakeNotWhenAwakeIsAlreadySetUp() {
        var h = TipHistory()
        h.observeChannels([], now: day0)
        h.observeChannels(["telegram"], now: day0)
        #expect(h.tipToShow(facts: TipFacts(awakeSetUp: true), now: day0, calendar: calendar) == nil)
    }

    @Test func theFirstLookAtChannelsIsNotAPairing() {
        var h = TipHistory()
        h.observeChannels(["phone-1", "telegram"], now: day0)
        #expect(h.pairedAt == nil)
        h.observeChannels(["phone-1", "telegram"], now: later(1))
        #expect(h.pairedAt == nil)
        h.observeChannels(["telegram"], now: later(2))   // one was revoked: not a pairing
        #expect(h.pairedAt == nil)
    }

    @Test func replyIntoConductorAfterAFallbackForAccessibility() {
        var h = TipHistory()
        #expect(h.tipToShow(facts: TipFacts(accessibilityGranted: false), now: day0, calendar: calendar) == nil)
        h.noteBackgroundFallbackForAccessibility(at: day0)
        #expect(h.tipToShow(facts: TipFacts(accessibilityGranted: nil), now: day0, calendar: calendar) == .replyIntoConductor)
        #expect(h.tipToShow(facts: TipFacts(accessibilityGranted: true), now: later(hours: 1), calendar: calendar) == nil)
        #expect(h.current == nil)
    }

    @Test func terminalAgentsAfterAnAutomationFailure() {
        var h = TipHistory()
        h.noteTerminalAutomationFailure(at: day0)
        #expect(h.tipToShow(facts: TipFacts(automationGranted: false), now: day0, calendar: calendar) == .answerTerminalAgents)
    }

    @Test func quickShortcutAfterThreeUsesWithoutInputMonitoring() {
        var h = TipHistory()
        h.noteComposerUse(); h.noteComposerUse()
        #expect(h.tipToShow(facts: TipFacts(), now: day0, calendar: calendar) == nil)
        h.noteComposerUse()
        #expect(h.tipToShow(facts: TipFacts(inputMonitoringGranted: true), now: day0, calendar: calendar) == nil)
        #expect(h.tipToShow(facts: TipFacts(inputMonitoringGranted: false), now: day0, calendar: calendar) == .quickShortcut)
    }

    @Test func phoneCallsNeedAChannelAQuarterHourAndNoCallsSetUp() {
        var h = TipHistory()
        #expect(h.tipToShow(facts: calls(wait: 14 * 60), now: day0, calendar: calendar) == nil)
        #expect(h.tipToShow(facts: TipFacts(longestQuestionWait: 3_600), now: day0, calendar: calendar) == nil)
        var done = calls(); done.voiceSetUp = true
        #expect(h.tipToShow(facts: done, now: day0, calendar: calendar) == nil)
        #expect(h.tipToShow(facts: calls(wait: 15 * 60), now: day0, calendar: calendar) == .phoneCalls)
    }

    @Test func notificationRulesOverTwentyFiveCards() {
        var h = TipHistory()
        #expect(h.tipToShow(facts: TipFacts(cardsPushedToday: 25), now: day0, calendar: calendar) == nil)
        #expect(h.tipToShow(facts: TipFacts(cardsPushedToday: 26), now: day0, calendar: calendar) == .notificationRules)
    }

    // MARK: Pace and dismissal

    @Test func oneAtATimeAndAnOnScreenTipStays() {
        var h = TipHistory()
        h.noteTerminalAutomationFailure(at: day0)
        h.noteBackgroundFallbackForAccessibility(at: day0)
        let both = TipFacts()
        #expect(h.tipToShow(facts: both, now: day0, calendar: calendar) == .replyIntoConductor)
        #expect(h.tipToShow(facts: both, now: later(hours: 5), calendar: calendar) == .replyIntoConductor)
        // Days later it is still the one on screen, not replaced by the other.
        #expect(h.tipToShow(facts: both, now: later(3), calendar: calendar) == .replyIntoConductor)
    }

    @Test func atMostOneNewTipADay() {
        var h = TipHistory()
        h.noteTerminalAutomationFailure(at: day0)
        h.noteBackgroundFallbackForAccessibility(at: day0)
        #expect(h.tipToShow(facts: TipFacts(), now: day0, calendar: calendar) == .replyIntoConductor)
        h.dismiss(.replyIntoConductor, forever: false, now: day0, calendar: calendar)
        // Same day: the next one waits.
        #expect(h.tipToShow(facts: TipFacts(), now: later(hours: 2), calendar: calendar) == nil)
        // Next day it starts.
        #expect(h.tipToShow(facts: TipFacts(), now: later(1), calendar: calendar) == .answerTerminalAgents)
    }

    @Test func notNowHidesForFourteenDays() {
        var h = TipHistory()
        let f = TipFacts(cardsPushedToday: 40)
        #expect(h.tipToShow(facts: f, now: day0, calendar: calendar) == .notificationRules)
        h.dismiss(.notificationRules, forever: false, now: day0, calendar: calendar)
        #expect(h.tipToShow(facts: f, now: later(13), calendar: calendar) == nil)
        #expect(h.tipToShow(facts: f, now: later(14, hours: 1), calendar: calendar) == .notificationRules)
    }

    @Test func dontShowAgainIsForever() {
        var h = TipHistory()
        let f = TipFacts(cardsPushedToday: 40)
        _ = h.tipToShow(facts: f, now: day0, calendar: calendar)
        h.dismiss(.notificationRules, forever: true, now: day0, calendar: calendar)
        #expect(h.tipToShow(facts: f, now: later(400), calendar: calendar) == nil)
    }

    @Test func openingATipRestsItLikeNotNow() {
        var h = TipHistory()
        let f = TipFacts(cardsPushedToday: 40)
        _ = h.tipToShow(facts: f, now: day0, calendar: calendar)
        h.opened(.notificationRules, now: day0, calendar: calendar)
        #expect(h.current == nil)
        #expect(h.tipToShow(facts: f, now: later(2), calendar: calendar) == nil)
    }

    @Test func destinationsOpenTheExplainerOrTheRightPage() {
        #expect(Tip.keepAwake.destination == .settings(.awake))
        #expect(Tip.replyIntoConductor.destination == .permission(.accessibility))
        #expect(Tip.answerTerminalAgents.destination == .permission(.automation))
        #expect(Tip.quickShortcut.destination == .permission(.inputMonitoring))
        #expect(Tip.phoneCalls.destination == .settings(.voice))
        #expect(Tip.notificationRules.destination == .settings(.notifications))
    }

    @Test func historySurvivesASaveAndAnOlderFile() throws {
        var h = TipHistory()
        _ = h.tipToShow(facts: TipFacts(cardsPushedToday: 40), now: day0, calendar: calendar)
        h.noteComposerUse()
        let again = try JSONDecoder().decode(TipHistory.self, from: JSONEncoder().encode(h))
        #expect(again == h)
        #expect(try JSONDecoder().decode(TipHistory.self, from: Data("{}".utf8)) == TipHistory())
    }

    // MARK: Signals

    @Test func questionWaitTracksFromFirstSeen() {
        var w = QuestionWaitTracker()
        w.observe(waiting: ["a"], now: day0)
        w.observe(waiting: ["a", "b"], now: later(hours: 1))
        #expect(w.longest(now: later(hours: 2)) == 7_200)
        w.observe(waiting: ["b"], now: later(hours: 2))
        #expect(w.longest(now: later(hours: 2)) == 3_600)
        w.observe(waiting: [], now: later(hours: 3))
        #expect(w.longest(now: later(hours: 3)) == nil)
    }

    @Test func replySignalsComeFromTheDaemonsSentences() {
        #expect(ReplyGrantSignal.read(via: "background", fallbackReason: "Squeak Hands has no Accessibility permission", refusedReason: nil) == .accessibility)
        #expect(ReplyGrantSignal.read(via: "background", fallbackReason: "the Mac is locked", refusedReason: nil) == nil)
        #expect(ReplyGrantSignal.read(via: "conductor", fallbackReason: nil, refusedReason: nil) == nil)
        #expect(ReplyGrantSignal.read(
            via: nil, fallbackReason: nil,
            refusedReason: "Squeak Hands is not allowed to control Terminal. Allow it in System Settings › Privacy & Security › Automation.") == .terminalAutomation)
        #expect(ReplyGrantSignal.read(via: nil, fallbackReason: nil, refusedReason: "Terminal is not open.") == nil)
    }
}
