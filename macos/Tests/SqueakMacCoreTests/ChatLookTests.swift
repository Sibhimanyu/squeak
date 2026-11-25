import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct ChatLookTests {
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func duck(_ id: String, ended: TimeInterval) -> HostSession {
        var s = HostSession(key: SessionKey(provider: "squeak", workspaceId: nil, hostSessionId: id), title: id, repoName: "r", branch: nil, cwd: "/w/r/\(id)",
                            agent: "claude", state: .finished, lastActivityAt: t0.addingTimeInterval(ended), alive: true)
        s.lastTurnEndedAt = t0.addingTimeInterval(ended)
        return s
    }

    /// A chat's id as the lists see it.
    func id(_ s: String) -> String { duck(s, ended: 0).key.stringValue }

    func screen(_ chat: String?, key: Bool = true, bottom: Bool = true, item: Bool = false) -> ChatLook {
        ChatLook.make(locationChat: chat.map(id), loadedChat: chat.map(id), centreItemOpen: item, windowOnScreen: true, windowKey: key, nearBottom: bottom)
    }

    /// Plays the model: settles the tracker, writes the log, answers what a list would show.
    struct Model {
        var log = ChatSeenLog(baseline: Date(timeIntervalSince1970: 1_799_999_000))
        var tracker = ChatReadTracker()
        mutating func settle(_ screen: ChatLook, _ s: HostSession) {
            if let key = tracker.settle(screen, available: true), key == s.key.stringValue { log.markOpened(s) }
        }
        func unread(_ s: HostSession, _ screen: ChatLook, now: Date) -> Bool { !screen.reads(s.key.stringValue) && log.isUnread(s, now: now) }
    }

    @Test func aChatOnScreenReadsEveryNewTurnAndStaysRead() {
        var m = Model()
        let on = screen("a")
        for end in [10.0, 20, 30] {
            let s = duck("a", ended: end)
            m.settle(on, s)
            #expect(!m.unread(s, on, now: t0.addingTimeInterval(end)))
        }
        // Looking away afterwards: the turn read last stays read.
        m.settle(screen(nil), duck("a", ended: 30))
        #expect(!m.log.isUnread(duck("a", ended: 30), now: t0.addingTimeInterval(31)))
    }

    @Test func openingAChatReadsItEvenWhenItIsNotAtTheBottom() {
        var m = Model()
        let s = duck("a", ended: 10)
        #expect(m.log.isUnread(s, now: t0.addingTimeInterval(11)))
        m.settle(screen("a", bottom: false), s)
        #expect(!m.log.isUnread(s, now: t0.addingTimeInterval(11)))
    }

    @Test func scrolledAwayANewFinishIsUnreadButTheOneReadBeforeIsNot() {
        var m = Model()
        m.settle(screen("a"), duck("a", ended: 10))
        let up = screen("a", bottom: false)
        let next = duck("a", ended: 20)
        m.settle(up, next)
        #expect(m.unread(next, up, now: t0.addingTimeInterval(21)))
        #expect(!m.unread(duck("a", ended: 10), up, now: t0.addingTimeInterval(21)))
    }

    @Test func leavingThenANewFinishShowsUnread() {
        var m = Model()
        m.settle(screen("a"), duck("a", ended: 10))
        m.settle(screen(nil), duck("a", ended: 10))
        let next = duck("a", ended: 20)
        m.settle(screen(nil), next)
        #expect(m.unread(next, screen(nil), now: t0.addingTimeInterval(21)))
        // Coming back opens it again and reads it.
        m.settle(screen("a"), next)
        #expect(!m.unread(next, screen("a"), now: t0.addingTimeInterval(21)))
    }

    @Test func aWindowThatIsNotKeyDoesNotRead() {
        var m = Model()
        let s = duck("a", ended: 10)
        m.settle(screen("a", key: false), s)
        #expect(m.unread(s, screen("a", key: false), now: t0.addingTimeInterval(11)))
        #expect(!screen("a", key: false).isLookingAt(id("a")))
    }

    @Test func aPageOrAnItemTabOverTheChatIsNotLookingAtIt() {
        // A pond page: the location is not the chat, though the chat is still loaded underneath.
        let page = ChatLook.make(locationChat: nil, loadedChat: id("a"), centreItemOpen: false, windowOnScreen: true, windowKey: true, nearBottom: true)
        #expect(page.visibleChat == nil)
        #expect(screen("a", item: true).visibleChat == nil)
        #expect(screen("a").visibleChat == id("a"))
        let hidden = ChatLook.make(locationChat: id("a"), loadedChat: id("a"), centreItemOpen: false, windowOnScreen: false, windowKey: true, nearBottom: true)
        #expect(hidden.visibleChat == nil)
    }

    @Test func noNotificationForTheVisibleChatOnly() {
        #expect(screen("a").isLookingAt(id("a")))
        #expect(!screen("a").isLookingAt(id("b")))
        // Scrolled up is still looking: no banner, though a new turn is not yet read.
        #expect(screen("a", bottom: false).isLookingAt(id("a")))
        #expect(!screen("a", bottom: false).reads(id("a")))
    }

    @Test func anOpeningWaitsForTheSessionToBeKnown() {
        var t = ChatReadTracker()
        #expect(t.settle(screen("a"), available: false) == nil)
        #expect(t.settle(screen("a"), available: true) == id("a"))
        #expect(t.settle(screen("a", bottom: false), available: true) == nil)
    }

    @Test func theBadgeTheCardAndTheTabAgree() {
        var m = Model()
        let a = duck("a", ended: 10), b = duck("b", ended: 12)
        m.settle(screen("a"), a)
        let on = screen("a")
        let now = t0.addingTimeInterval(20)
        func chat(_ s: HostSession) -> ForYouChat {
            ForYouChat(sessionId: s.key.hostSessionId, duckName: s.title, title: s.title, unread: m.unread(s, on, now: now), waiting: false)
        }
        let list = PondForYou.build([chat(a), chat(b)])
        #expect(list.items.map(\.sessionId) == ["b"])
        #expect(list.marks().badge == 1)
        #expect(ChatMark.of(a, unread: m.unread(a, on, now: now), now: now) == nil)
        #expect(ChatMark.of(b, unread: m.unread(b, on, now: now), now: now)?.kind == .unread)
    }
}
