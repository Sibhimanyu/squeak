import Foundation
import Testing
@testable import SqueakMacCore

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)
private func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
private func key(_ id: String = "a") -> SessionKey { SessionKey(provider: "conductor", hostSessionId: id) }

private func msg(_ id: String, _ role: MessageRole, _ s: TimeInterval?, turn: String? = nil, text: String? = nil) -> ChatMessage {
    ChatMessage(id: id, role: role, text: text ?? "text \(id)", at: s.map(at), turnId: turn)
}

private func anchor(_ s: TimeInterval?, message: String? = nil, turn: String? = nil, id: String = "e1") -> NotificationAnchor {
    NotificationAnchor(eventId: id, kind: .finished, at: s.map(at), messageId: message, turnId: turn)
}

@Suite struct NotificationContextResolveTests {
    private let transcript = [
        msg("u1", .user, 0), msg("a1", .assistant, 10), msg("u2", .user, 100), msg("a2", .assistant, 110),
    ]

    @Test func anOldNotificationShowsItsOwnReplyNotTheNewerOne() {
        let c = NotificationContextPolicy.resolve(messages: transcript, anchor: anchor(12, message: "a1"))
        #expect(c.confidence == .exact)
        #expect(c.response?.id == "a1")
        #expect(c.request?.id == "u1") // the request that prompted it, not the later one
        #expect(c.note == nil)
    }

    @Test func aTurnIdentityIsExactToo() {
        let msgs = [msg("u1", .user, 0, turn: "t1"), msg("a1", .assistant, 5, turn: "t1"), msg("u2", .user, 50, turn: "t2"), msg("a2", .assistant, 60, turn: "t2")]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(nil, turn: "t1"))
        #expect(c.confidence == .exact)
        #expect(c.response?.id == "a1")
    }

    @Test func severalAssistantMessagesInOneTurnAreGroupedWithTheRequest() {
        let msgs = [
            msg("u0", .user, 0, turn: "t0"), msg("a0", .assistant, 5, turn: "t0"),
            msg("u1", .user, 20, turn: "t1"), msg("a1a", .assistant, 22, turn: "t1"), msg("a1b", .assistant, 25, turn: "t1"), msg("a1c", .assistant, 30, turn: "t1"),
        ]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(30, message: "a1c"))
        #expect(c.response?.id == "a1c")
        #expect(c.earlier.map(\.id) == ["a1a", "a1b"])
        #expect(c.request?.id == "u1")
        #expect(c.hasEarlier)
    }

    @Test func noIdentityMatchesByTimeAtOrBeforeTheEvent() {
        let c = NotificationContextPolicy.resolve(messages: transcript, anchor: anchor(15))
        #expect(c.confidence == .atOrBeforeEvent)
        #expect(c.response?.id == "a1")
        #expect(c.note != nil)
    }

    @Test func aMissingMessageFallsBackToTimeNotToTheLatest() {
        let c = NotificationContextPolicy.resolve(messages: transcript, anchor: anchor(15, message: "gone"))
        #expect(c.response?.id == "a1")
        #expect(c.confidence == .atOrBeforeEvent)
    }

    @Test func anUntimedReplyAfterTheMatchMakesTimeUntrustworthy() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 10), msg("a2", .assistant, nil)]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(15))
        #expect(c.confidence == .unavailable)
        #expect(c.response == nil)
    }

    @Test func aRequestWithNoReplyBeforeTheEventDoesNotBorrowThePreviousTurnsReply() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 10), msg("u2", .user, 20)]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(30))
        #expect(c.confidence == .unavailable)
        #expect(c.response == nil)
    }

    @Test func aRequestTypedAfterTheEventDoesNotHideTheEventsReply() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 10), msg("u2", .user, 50)]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(12))
        #expect(c.response?.id == "a1")
    }

    @Test func noTimesAnywhereIsFreshEnoughOnlyForARecentEvent() {
        let msgs = [msg("u1", .user, nil), msg("a1", .assistant, nil)]
        let fresh = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(0), now: at(30))
        #expect(fresh.confidence == .latestAvailable)
        let stale = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(0), now: at(3_600))
        #expect(stale.confidence == .unavailable)
    }

    @Test func aPreUpgradeNotificationShowsTheLatestAndSaysSo() {
        let c = NotificationContextPolicy.resolve(messages: transcript, anchor: nil, fromNotification: true)
        #expect(c.confidence == .latestAvailable)
        #expect(c.response?.id == "a2")
        #expect(c.note?.contains("older version") == true)
        #expect(NotificationContextPolicy.resolve(messages: transcript, anchor: nil).note == nil)
    }

    @Test func theLatestSaysWhenANewerRequestHasNoReply() {
        let msgs = transcript + [msg("u3", .user, 200)]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: nil)
        #expect(c.response?.id == "a2")
        #expect(c.note?.contains("no reply yet") == true)
    }

    @Test func aChatWithNoReplyHasNothingToShow() {
        let c = NotificationContextPolicy.resolve(messages: [msg("u1", .user, 0)], anchor: nil)
        #expect(c.confidence == .unavailable)
    }

    @Test func ourOwnUnconfirmedSendsAreNeverContext() {
        let msgs = transcript + [ChatMessage(id: "local-x", role: .user, text: "pending", at: at(300))]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: nil)
        #expect(c.note == nil)
    }

    @Test func fullTextIsNeverClipped() {
        let long = String(repeating: "word ", count: 20_000)
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 5, text: long)]
        #expect(NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(6, message: "a1")).response?.text == long)
    }
}

@Suite struct NotificationAnchorCaptureTests {
    private func event(at s: TimeInterval) -> NotificationEvent {
        NotificationEvent(key: key(), kind: .finished, title: "Squeak", body: "done", id: "ev", at: at(s))
    }

    @Test func pinsTheReplyThatEndedTheTurn() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 10)]
        let a = NotificationContextPolicy.anchorNow(event: event(at: 11), messages: msgs, now: at(12))
        #expect(a?.messageId == "a1")
    }

    @Test func aStalePreviousReplyIsNotPinnedWhenANewerRequestHasNone() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 10), msg("u2", .user, 20)]
        let a = NotificationContextPolicy.anchorNow(event: event(at: 30), messages: msgs, now: at(31))
        #expect(a != nil)
        #expect(a?.messageId == nil)
        #expect(a?.at == at(30)) // the time-only anchor survives
    }

    @Test func aCaptureThatSeesMessagesAfterTheEventPinsTheEventsReply() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 10), msg("u2", .user, 50), msg("a2", .assistant, 60)]
        let a = NotificationContextPolicy.anchorNow(event: event(at: 12), messages: msgs, now: at(90))
        #expect(a?.messageId == "a1")
    }

    @Test func aReplyAfterTheEventIsNotPinnedWhenItIsTheOnlyOne() {
        let msgs = [msg("u1", .user, 0), msg("a1", .assistant, 60)]
        let a = NotificationContextPolicy.anchorNow(event: event(at: 12), messages: msgs, now: at(90))
        #expect(a?.messageId == nil)
    }

    @Test func anUntimedReplyIsNeverPinnedNotEvenByAFreshCapture() {
        let msgs = [msg("u1", .user, nil), msg("a1", .assistant, nil)]
        let fresh = NotificationContextPolicy.anchorNow(event: event(at: 0), messages: msgs, now: at(5))
        #expect(fresh?.messageId == nil)
        #expect(fresh?.turnId == nil)
        #expect(fresh?.at == at(0)) // the time-only anchor is kept
        // Still an honest fallback: the latest, labelled as such, while the event is fresh.
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: fresh, now: at(5))
        #expect(c.confidence == .latestAvailable)
        #expect(c.note != nil)
    }

    @Test func aNewerUntimedTurnIsNeverPresentedAsExactForAnOldEvent() {
        // A delayed capture already holds a second, untimed request and reply.
        let msgs = [msg("u1", .user, nil), msg("a1", .assistant, nil), msg("u2", .user, nil), msg("a2", .assistant, nil)]
        let a = NotificationContextPolicy.anchorNow(event: event(at: 0), messages: msgs, now: at(10))
        #expect(a?.messageId == nil)
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: a, now: at(10))
        #expect(c.confidence != .exact)
        let later = NotificationContextPolicy.resolve(messages: msgs, anchor: a, now: at(3_600))
        #expect(later.confidence == .unavailable)
    }

    @Test func anExplicitAnchorToAnUntimedCachedMessageStillResolvesExactly() {
        let msgs = [msg("u1", .user, nil), msg("a1", .assistant, nil), msg("u2", .user, nil), msg("a2", .assistant, nil)]
        let c = NotificationContextPolicy.resolve(messages: msgs, anchor: anchor(0, message: "a1"))
        #expect(c.confidence == .exact)
        #expect(c.response?.id == "a1")
    }

    @Test func anEventWithoutAnIdHasNoAnchor() {
        let bare = NotificationEvent(key: key(), kind: .finished, title: "t", body: "b")
        #expect(NotificationContextPolicy.anchorNow(event: bare, messages: []) == nil)
    }
}

@Suite struct NotificationContextMergeTests {
    @Test func twoEventsInOneSessionSurviveALiveTailThatExcludesTheOlder() {
        let cached = [
            msg("u1", .user, 0), msg("a1", .assistant, 10), // event 1
            msg("u2", .user, 100), msg("a2", .assistant, 110), // event 2
        ]
        let live = [msg("u3", .user, 200), msg("a3", .assistant, 210)]
        let merged = NotificationContextPolicy.merge(cached: cached, live: live)
        #expect(merged.map(\.id) == ["u1", "a1", "u2", "a2", "u3", "a3"])
        let old = NotificationContextPolicy.resolve(messages: merged, anchor: anchor(12, message: "a1", id: "e1"))
        #expect(old.confidence == .exact)
        #expect(old.response?.id == "a1")
        #expect(old.request?.id == "u1")
        let older = NotificationContextPolicy.resolve(messages: merged, anchor: anchor(12, id: "e1"))
        #expect(older.response?.id == "a1") // precise by time as well
    }

    @Test func untimedCachedMessagesWithAnIdentityAreKept() {
        let cached = [msg("u1", .user, nil), msg("a1", .assistant, nil)]
        let live = [msg("u2", .user, 100), msg("a2", .assistant, 110)]
        let merged = NotificationContextPolicy.merge(cached: cached, live: live)
        #expect(Set(merged.map(\.id)) == ["u1", "a1", "u2", "a2"])
        let c = NotificationContextPolicy.resolve(messages: merged, anchor: anchor(nil, message: "a1"))
        #expect(c.confidence == .exact)
        #expect(c.response?.id == "a1")
    }

    @Test func mixedDatedAndUndatedMergeHasNoDuplicatesAndIsStable() {
        let cached = [msg("a", .user, 10), msg("b", .assistant, nil), msg("c", .assistant, 30), msg("d", .assistant, nil)]
        let live = [msg("c", .assistant, 30), msg("e", .user, 50)]
        let once = NotificationContextPolicy.merge(cached: cached, live: live)
        #expect(once.map(\.id) == ["a", "b", "c", "d", "e"])
        #expect(Set(once.map(\.id)).count == once.count)
        #expect(NotificationContextPolicy.merge(cached: cached, live: live) == once)
        #expect(NotificationContextPolicy.merge(cached: once, live: live) == once)
    }

    @Test func theLiveReadWinsOnASharedId() {
        let cached = [msg("a", .assistant, 10, text: "old text")]
        let live = [msg("a", .assistant, 10, text: "new text")]
        #expect(NotificationContextPolicy.merge(cached: cached, live: live).first?.text == "new text")
    }

    @Test func cacheOnlyInputDropsDuplicatesAndPlacesTimedMessagesByTime() {
        let cached = [msg("z", .user, 50), msg("y", .assistant, nil), msg("z", .user, 50), msg("x", .assistant, 10)]
        // y has no time, so it stays right after z, the message it followed; x's time puts it first.
        #expect(NotificationContextPolicy.merge(cached: cached, live: []).map(\.id) == ["x", "z", "y"])
    }

    @Test func excerptsAreOneShortPlainLine() {
        let e = NotificationContextPolicy.excerpt("## Done\n\n**All** tests pass.\n" + String(repeating: "more words ", count: 40), limit: 60)
        #expect(!e.contains("\n"))
        #expect(!e.contains("**"))
        #expect(e.count <= 62)
        #expect(e.hasSuffix("…"))
    }
}

@Suite struct NotificationAnchorTests {
    @Test func userInfoCarriesOnlyIdsAndTimes() {
        let a = NotificationAnchor(eventId: "e", kind: .question, at: at(5), messageId: "m", turnId: "t")
        let info = a.userInfo(session: key())
        #expect(Set(info.keys) == ["session", "event", "kind", "at", "message", "turn"])
        let parsed = NotificationAnchor.parse(info)
        #expect(parsed == a)
    }

    @Test func aLegacyNotificationHasNoAnchor() {
        #expect(NotificationAnchor.parse(["session": key().stringValue]) == nil)
        #expect(NotificationAnchor.parse(["event": ""]) == nil)
    }

    @Test func theLogFillsInIdentityLearnedAfterThePost() {
        var log = NotificationAnchorLog()
        log.record(NotificationAnchor(eventId: "e", kind: .finished, at: at(5), messageId: "m", turnId: "t"))
        let resolved = log.resolve(NotificationAnchor(eventId: "e", kind: .finished, at: at(5)))
        #expect(resolved.messageId == "m")
        #expect(log.resolve(NotificationAnchor(eventId: "other")).messageId == nil)
    }

    @Test func theLogIsBounded() {
        var log = NotificationAnchorLog()
        for i in 0..<(NotificationAnchorLog.capacity + 10) { log.record(NotificationAnchor(eventId: "e\(i)")) }
        #expect(log.entries.count == NotificationAnchorLog.capacity)
        #expect(log.entries.first?.eventId == "e10")
    }

    @Test func detectStampsEventsOnlyWhenToldTheTime() {
        let before = [makeSession("a", state: .working)]
        let after = [makeSession("a", state: .finished)]
        #expect(NotificationPolicy.detect(previous: before, current: after).first?.id == nil)
        let stamped = NotificationPolicy.detect(previous: before, current: after, at: at(7))
        #expect(stamped.first?.at == at(7))
        #expect(stamped.first?.id == NotificationEvent.eventId(key: after[0].key, kind: .finished, at: at(7)))
    }

    @Test func aClickKeepsItsEventAndADismissalOpensNothing() {
        let a = anchor(5)
        let open = NotificationRouting.openRequest(dismissed: false, session: key().stringValue, anchor: a)
        #expect(open == PendingNotificationOpen(key: key(), anchor: a))
        #expect(NotificationRouting.openRequest(dismissed: true, session: key().stringValue, anchor: a) == nil)
        #expect(NotificationRouting.openRequest(dismissed: false, session: "nope", anchor: a) == nil)
    }

    @Test func anEarlyClickIsKeptWithItsEventUntilTheHandlerExists() {
        var p = PendingNotificationOpens()
        #expect(p.deliver(PendingNotificationOpen(key: key("a"), anchor: anchor(1, id: "x")), handlerReady: false) == nil)
        #expect(p.deliver(PendingNotificationOpen(key: key("b"), anchor: anchor(2, id: "y")), handlerReady: false) == nil)
        #expect(p.drain()?.anchor?.eventId == "y")
        #expect(p.drain() == nil)
    }
}

@Suite struct ContextGateAndUnreadTests {
    @Test func aLoadFromAnEarlierShowOrChatIsRefused() {
        var gate = ContextLoadGate()
        let first = gate.begin(key: key("a"), eventId: "e1")
        let second = gate.begin(key: key("b"), eventId: "e2")
        #expect(!gate.accepts(first))
        #expect(gate.accepts(second))
        gate.invalidate()
        #expect(!gate.accepts(second))
        let again = gate.begin(key: key("b"), eventId: "e2")
        #expect(gate.accepts(again))
        #expect(!gate.accepts(second)) // same chat and event, older show
    }

    @Test func anEventStaysUnreadUntilItsContentIsDisplayed() {
        var u = UnreadTracker()
        let first = u.note(key(), id: "e1", at: at(10))
        let again = u.note(key(), id: "e1", at: at(10))
        #expect(first)
        #expect(!again)
        #expect(u.hasUnread(key()))
        #expect(!u.hasUnread(key("other")))
        u.markRead(key(), through: at(10))
        #expect(!u.hasUnread(key()))
        let afterRead = u.note(key(), id: "e1", at: at(10))
        #expect(!afterRead) // already read: not announced again
    }

    @Test func aLaterUpdateIsNotClearedByAnEarlierDisplay() {
        var u = UnreadTracker()
        u.note(key(), id: "e1", at: at(10))
        u.note(key(), id: "e2", at: at(50))
        u.markRead(key(), through: at(20))
        #expect(u.hasUnread(key()))
        u.markRead(eventId: "e2")
        #expect(!u.hasUnread(key()))
    }

    @Test func unreadRoundTripsThroughDefaultsAndIsBounded() throws {
        var u = UnreadTracker()
        for i in 0..<(UnreadTracker.readCapacity + 20) {
            u.note(key("k\(i % 3)"), id: "e\(i)", at: at(TimeInterval(i)))
        }
        #expect(u.pending.values.allSatisfy { $0.count <= UnreadTracker.perChat })
        for k in 0..<3 { u.markRead(key("k\(k)")) }
        #expect(u.read.count == 3 * UnreadTracker.perChat)
        for i in 0..<(UnreadTracker.readCapacity + 20) { u.markRead(eventId: "r\(i)") }
        #expect(u.read.count == UnreadTracker.readCapacity)
        let back = try JSONDecoder().decode(UnreadTracker.self, from: JSONEncoder().encode(u))
        #expect(back == u)
    }

    @Test func statusLinesNameTheEvent() {
        #expect(ContextStatusLine.make(kind: .finished).text == "Finished")
        #expect(ContextStatusLine.make(kind: nil).symbol == .neutral)
    }
}

@Suite struct BrokerContextTests {
    @Test func readingAContextNeverTouchesTheFocusedConversation() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        await a.setTranscript([ChatMessage(id: "m1", role: .assistant, text: "hi", at: at(1))])
        let broker = Broker(adapters: [a], clock: FakeClock())
        await broker.refresh()
        let read = await broker.readTranscript(for: s.key)
        guard case .messages(let list, _) = read else {
            Issue.record("expected messages")
            return
        }
        #expect(list.map(\.id) == ["m1"])
        #expect(await broker.messages(for: s.key).isEmpty) // nothing leaked into the focused view
    }

    @Test func missingAndUnreachableChatsAreToldApart() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        let broker = Broker(adapters: [a], clock: FakeClock())
        #expect(await broker.readTranscript(for: s.key) == .sessionGone) // catalog not loaded yet
        await broker.refresh()
        await a.setFailure(.daemonDown)
        #expect(await broker.readTranscript(for: s.key) == .offline)
        await a.setFailure(.http(500))
        #expect(await broker.readTranscript(for: s.key) == .failed)
        #expect(await broker.readTranscript(for: key("missing")) == .sessionGone)
    }

    @Test func captureDoesNotPinAReplyThatCameAfterTheEvent() async {
        let s = makeSession("c1")
        let a = FakeAdapter(sessions: [s])
        let clock = FakeClock()
        let eventAt = clock.now()
        await a.setTranscript([
            ChatMessage(id: "u1", role: .user, text: "q", at: eventAt.addingTimeInterval(-30)),
            ChatMessage(id: "a1", role: .assistant, text: "first", at: eventAt.addingTimeInterval(-2)),
            ChatMessage(id: "u2", role: .user, text: "q2", at: eventAt.addingTimeInterval(20)),
            ChatMessage(id: "a2", role: .assistant, text: "second", at: eventAt.addingTimeInterval(25)),
        ])
        let broker = Broker(adapters: [a], clock: clock)
        await broker.refresh()
        let event = NotificationEvent(key: s.key, kind: .finished, title: "t", body: "b",
                                      id: NotificationEvent.eventId(key: s.key, kind: .finished, at: eventAt), at: eventAt)
        let capture = await broker.capture(event)
        #expect(capture.anchor?.messageId == "a1")
        #expect(capture.messages.map(\.id) == ["u1", "a1"])
    }
}
