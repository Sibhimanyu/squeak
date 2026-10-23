import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Ordering")
struct OrderingTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func groupsPinnedActiveRecent() {
        let pinned = makeSession("pin", state: .idle, at: now.addingTimeInterval(-9000))
        let working = makeSession("w", state: .working, at: now.addingTimeInterval(-30))
        let blocked = makeSession("b", state: .blocked, at: now.addingTimeInterval(-10))
        let freshFinish = makeSession("f", state: .finished, at: now.addingTimeInterval(-300))
        let oldFinish = makeSession("of", state: .finished, at: now.addingTimeInterval(-25 * 3600))
        let idle = makeSession("i", state: .idle, at: now.addingTimeInterval(-60))
        let unknownTime = makeSession("u", state: .idle, at: nil)
        let deadWorking = makeSession("dead", state: .working, at: now, alive: false)

        let o = SessionOrdering.order(
            [unknownTime, idle, oldFinish, freshFinish, working, blocked, pinned, deadWorking],
            pinned: [pinned.key], now: now
        )
        #expect(o.pinned.map(\.key.hostSessionId) == ["pin"])
        #expect(o.active.map(\.key.hostSessionId) == ["b", "w", "f"])
        // Newest first; unknown time last.
        #expect(o.recent.map(\.key.hostSessionId) == ["dead", "i", "of", "u"])
        #expect(o.flattened.count == 8)
    }

    @Test func orderIsStableForEqualTimes() {
        let a = makeSession("a", state: .idle, at: now)
        let b = makeSession("b", state: .idle, at: now)
        #expect(SessionOrdering.order([b, a], now: now).recent.map(\.key.hostSessionId)
            == SessionOrdering.order([a, b], now: now).recent.map(\.key.hostSessionId))
    }
}

@Suite("Search")
struct SearchTests {
    @Test func searchesTitlesAndMessagesIgnoringCaseAndDiacritics() {
        let s1 = makeSession("1", title: "Café menu redesign")
        let s2 = makeSession("2", title: "Unrelated")
        let s3 = makeSession("3", title: "Another")
        let index = SearchIndex(sessions: [s2, s1, s3], messages: [
            s2.key: [ChatMessage(id: "m", role: .assistant, text: "We should rename the CAFE sign")],
            s3.key: [ChatMessage(id: "m", role: .user, text: "nothing relevant")],
        ])
        let hits = index.search("cafe")
        #expect(hits.map(\.key) == [s1.key, s2.key]) // title match first
        #expect(hits[0].titleMatch && !hits[1].titleMatch)
        #expect(hits[1].messageId == "m" && hits[1].snippet?.contains("CAFE") == true)
        #expect(index.search("CAFÉ MENU").map(\.key) == [s1.key])
        #expect(index.search("   ").isEmpty)
        #expect(index.search("zzz").isEmpty)
    }

    @Test func allTermsMustMatchAcrossTitleAndMessages() {
        let s = makeSession("1", title: "Harbor")
        let index = SearchIndex(sessions: [s], messages: [s.key: [ChatMessage(id: "m", role: .user, text: "lighthouse repairs")]])
        #expect(index.search("harbor lighthouse").count == 1)
        #expect(index.search("harbor volcano").isEmpty)
    }
}

@Suite("Notifications")
struct NotificationTests {
    @Test func firstLoadNeverNotifies() {
        let cur = [makeSession("a", state: .blocked), makeSession("b", state: .finished)]
        #expect(NotificationPolicy.detect(previous: nil, current: cur).isEmpty)
    }

    @Test func blockedNotifiesForAnyProvider() {
        let prev = [makeSession("a", provider: "codex-terminal", state: .working)]
        let cur = [makeSession("a", provider: "codex-terminal", state: .blocked)]
        let n = NotificationPolicy.detect(previous: prev, current: cur)
        #expect(n.map(\.kind) == [.blocked])
    }

    @Test func finishNotifiesOnlyForConductor() {
        let prev = [makeSession("a", state: .working), makeSession("t", provider: "claude-terminal", state: .working)]
        let cur = [makeSession("a", state: .finished), makeSession("t", provider: "claude-terminal", state: .finished)]
        let n = NotificationPolicy.detect(previous: prev, current: cur)
        #expect(n.map(\.kind) == [.finished])
        #expect(n[0].key.provider == "conductor")
    }

    @Test func errorNotifiesAndUnchangedStatesDoNot() {
        let prev = [makeSession("a", state: .working), makeSession("b", state: .blocked)]
        let cur = [makeSession("a", state: .error), makeSession("b", state: .blocked)]
        #expect(NotificationPolicy.detect(previous: prev, current: cur).map(\.kind) == [.error])
    }

    @Test func newSessionsAndNonEventTransitionsDoNotNotify() {
        let prev = [makeSession("a", state: .blocked)]
        let cur = [makeSession("a", state: .working), makeSession("new", state: .blocked)]
        #expect(NotificationPolicy.detect(previous: prev, current: cur).isEmpty)
    }

    @Test func bodyHasLabelAndEventOnly() {
        var s = makeSession("a", state: .working)
        s.title = "Fix login"
        var done = s
        done.state = .finished
        let n = NotificationPolicy.detect(previous: [s], current: [done])
        #expect(n.count == 1)
        #expect(n[0].title == "Squeak")
        #expect(n[0].body == "Fix login finished")
    }

    @Test func aQuestionSaysItIsAQuestionAndCarriesIt() {
        let prev = [makeSession("a", state: .working)]
        var asking = makeSession("a", state: .blocked)
        asking.pendingQuestion = "Which database? (Postgres / SQLite)"
        let n = NotificationPolicy.detect(previous: prev, current: [asking])
        #expect(n.map(\.kind) == [.question])
        #expect(n[0].body == "Session a is asking you something")
        #expect(n[0].detail == "Which database? (Postgres / SQLite)")
    }

    @Test func aPlanAndAnApprovalAreToldApart() {
        let prev = [makeSession("p", state: .working), makeSession("x", provider: "claude-terminal", state: .working)]
        var plan = makeSession("p", state: .blocked)
        plan.pendingQuestion = "has a plan for you to review"
        var approval = makeSession("x", provider: "claude-terminal", state: .blocked)
        approval.awaitingApproval = true
        let n = NotificationPolicy.detect(previous: prev, current: [plan, approval])
        #expect(n.map(\.kind) == [.plan, .blocked])
        #expect(n[1].body == "Session x needs your approval")
    }

    @Test func aSecondQuestionWhileStillWaitingIsNews() {
        var first = makeSession("a", state: .blocked)
        first.pendingQuestion = "Ship it?"
        var second = first
        second.pendingQuestion = "Which branch?"
        #expect(NotificationPolicy.detect(previous: [first], current: [first]).isEmpty)
        #expect(NotificationPolicy.detect(previous: [first], current: [second]).map(\.kind) == [.question])
    }

    @Test func aFinishThatAsksIsOneQuestionBannerNotAFinishToo() {
        let prev = [makeSession("a", state: .working)]
        var asking = makeSession("a", state: .blocked)
        asking.pendingQuestion = "Want me to open a PR?"
        let n = NotificationPolicy.detect(previous: prev, current: [asking])
        #expect(n.map(\.kind) == [.question])
        #expect(n[0].detail == "Want me to open a PR?")
        // Still asking on the next poll: nothing new to say.
        #expect(NotificationPolicy.detect(previous: [asking], current: [asking]).isEmpty)
    }

    @Test func aFinishedChatSqueakCannotSendToStillNotifies() {
        let prev = [makeSession("a", state: .working, canSend: false)]
        let n = NotificationPolicy.detect(previous: prev, current: [makeSession("a", state: .finished, canSend: false)])
        #expect(n.map(\.kind) == [.finished]) // the composer it opens says it cannot take a reply
    }

    private func key(_ id: String) -> SessionKey { makeSession(id, state: .working).key }

    @Test func aClickedNotificationsChatBeatsLastUsedAndNeedsYou() {
        let target = ComposerRouting.target(explicit: key("n"), lastUsed: key("l"), needsYou: [key("y")], canSend: { _ in true })
        #expect(target == key("n"))
    }

    @Test func aStaleNotificationTargetIsKeptNotReplaced() {
        let target = ComposerRouting.target(explicit: key("gone"), lastUsed: key("l"), needsYou: [key("y")], canSend: { $0 != key("gone") })
        #expect(target == key("gone"))
    }

    @Test func withoutAnExplicitTargetLastUsedThenNeedsYou() {
        #expect(ComposerRouting.target(explicit: nil, lastUsed: key("l"), needsYou: [key("y")], canSend: { _ in true }) == key("l"))
        let skip = ComposerRouting.target(explicit: nil, lastUsed: key("l"), needsYou: [key("x"), key("y")], canSend: { $0 == key("y") })
        #expect(skip == key("y"))
        #expect(ComposerRouting.target(explicit: nil, lastUsed: nil, needsYou: [], canSend: { _ in true }) == nil)
    }

    @Test func draftsStayWithTheirChat() {
        var drafts = ComposerDrafts()
        drafts.stash("for a", for: key("a"))
        #expect(drafts.text(for: key("a")) == "for a")
        #expect(drafts.text(for: key("b")).isEmpty)
        #expect(drafts.text(for: nil).isEmpty)
        drafts.stash("  \n", for: key("a"))
        #expect(drafts.text(for: key("a")).isEmpty)
    }

    @Test func aSentDraftIsForgottenButANewerOneSurvives() {
        var drafts = ComposerDrafts()
        drafts.stash("hello", for: key("a"))
        drafts.sent("hello", to: key("a"))
        #expect(drafts.text(for: key("a")).isEmpty)
        drafts.stash("hello again", for: key("a"))
        drafts.sent("hello", to: key("a"))
        #expect(drafts.text(for: key("a")) == "hello again")
    }

    @Test func textTypedBeforeAnyChatSurvivesHidingAndGoesToTheFirstChatChosen() {
        var drafts = ComposerDrafts()
        drafts.stash("typed early", for: nil)
        #expect(drafts.text(for: nil) == "typed early")
        #expect(drafts.text(for: key("a")).isEmpty)
        #expect(drafts.choose(key("a"), from: nil, current: "typed early") == "typed early")
        #expect(drafts.text(for: nil).isEmpty) // moved, not copied
    }

    @Test func choosingAChatKeepsBothTheCarriedTextAndItsOwnDraft() {
        var drafts = ComposerDrafts()
        drafts.stash("old draft", for: key("a"))
        #expect(drafts.choose(key("a"), from: nil, current: "new") == "old draft\n\nnew")
        #expect(drafts.choose(key("b"), from: nil, current: "  ").isEmpty)
    }

    @Test func switchingChatsSwapsDraftsAndKeepsEachSeparate() {
        var drafts = ComposerDrafts()
        drafts.stash("for b", for: key("b"))
        #expect(drafts.choose(key("b"), from: key("a"), current: "for a") == "for b")
        #expect(drafts.text(for: key("a")) == "for a")
        #expect(drafts.choose(key("b"), from: key("b"), current: "same") == "same")
    }

    @Test func aLateAcceptedSendClearsTheSameTextRestoredInTheSameChatOnly() {
        func settle(target: SessionKey?, text: String, accepted: Bool, started: Int = 1, current: Int = 3) -> ComposerDrafts.Settlement {
            ComposerDrafts.settlement(sent: "hi", to: key("a"), startedEpoch: started, currentEpoch: current, target: target, text: text, accepted: accepted)
        }
        #expect(settle(target: key("a"), text: "hi", accepted: true).clearText)
        #expect(!settle(target: key("a"), text: "hi", accepted: true).adoptResult) // never closes or reports for a reopened composer
        #expect(!settle(target: key("a"), text: "hi edited", accepted: true).clearText)
        #expect(!settle(target: key("b"), text: "hi", accepted: true).clearText)
        #expect(settle(target: key("a"), text: "hi", accepted: true, started: 3).adoptResult)
    }

    @Test func aLateFailureOnlyInformsTheSameRestoredText() {
        func adopt(target: SessionKey?, text: String) -> Bool {
            ComposerDrafts.settlement(sent: "hi", to: key("a"), startedEpoch: 1, currentEpoch: 2, target: target, text: text, accepted: false).adoptResult
        }
        #expect(adopt(target: key("a"), text: "hi"))
        #expect(!adopt(target: key("b"), text: "hi"))
        #expect(!adopt(target: key("a"), text: "other"))
    }

    @Test func aNotificationResponseOpensItsChatUnlessDismissedOrMalformed() {
        let raw = key("a").stringValue
        #expect(NotificationRouting.sessionToOpen(dismissed: false, session: raw) == key("a"))
        #expect(NotificationRouting.sessionToOpen(dismissed: true, session: raw) == nil)
        #expect(NotificationRouting.sessionToOpen(dismissed: false, session: "not a key") == nil)
        #expect(NotificationRouting.sessionToOpen(dismissed: false, session: nil) == nil)
    }
}

@Suite struct NotificationActivationTests {
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "conductor", hostSessionId: id) }

    @Test func reopenWithoutAnOrdinaryWindowShowsTheComposerNeverTheConversation() {
        #expect(ReopenPolicy.action(hasOrdinaryWindow: false) == .showQuickComposer)
        #expect(ReopenPolicy.action(hasOrdinaryWindow: true) == .none)
    }

    @Test func anEarlyClickIsKeptUntilTheHandlerExists() {
        var p = PendingOpens()
        #expect(p.deliver(key("a"), handlerReady: false) == nil)
        #expect(p.deliver(key("b"), handlerReady: false) == nil)
        #expect(p.drain() == key("b"))
        #expect(p.drain() == nil)
        #expect(p.deliver(key("c"), handlerReady: true) == key("c"))
        #expect(p.drain() == nil)
    }
}
