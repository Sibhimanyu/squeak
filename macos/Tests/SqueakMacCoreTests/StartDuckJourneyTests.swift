import Foundation
import Testing
@testable import SqueakMacCore

/// Issue 116: Esc on New duck returns to the Pond it was opened from, a Pond start opens the new Duck's page, and the
/// Duck page holds a "Starting…" state (and typed messages) until the host confirms, never navigating away meanwhile.
@Suite struct StartDuckJourneyTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let pond = "pond-1"
    private func held(_ s: inout DuckStart, _ t: String) -> Bool { s.hold(t) }
    private let chat = SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + "s1")

    // MARK: Esc / Cancel returns to the Pond

    @Test func newDuckOpenedFromAPondReturnsToThatPond() {
        var back = WorkbenchLocation.home
        // The person was reading a chat, then opened the Pond; the Pond's Start a duck opens the page straight from it.
        for shown in [WorkbenchLocation.chat(chat), .pondHome(pond: pond), .compose(.newThread, pond: pond, workspace: nil)] {
            back = .returnPlace(afterShowing: shown, current: back)
        }
        #expect(back == .pondHome(pond: pond))
    }

    @Test func leavingThePondFirstWouldReturnElsewhere() {
        // What PondHome did (closePondPage before opening the page): the place to return to became the chat or the Dashboard.
        var back = WorkbenchLocation.home
        for shown in [WorkbenchLocation.pondHome(pond: pond), .home, .compose(.newThread, pond: pond, workspace: nil)] {
            back = .returnPlace(afterShowing: shown, current: back)
        }
        #expect(back == .home)
    }

    @Test func settingsAndArtifactsNeverBecomeThePlaceToReturnTo() {
        var back = WorkbenchLocation.pondHome(pond: pond)
        for shown in [WorkbenchLocation.settings(.general), .artifact(pond: pond, path: "/x"), .compose(.newThread, pond: pond, workspace: nil)] {
            back = .returnPlace(afterShowing: shown, current: back)
        }
        #expect(back == .pondHome(pond: pond))
    }

    // MARK: A Pond start opens the Duck's page

    private func thread(sessionId: String?) -> PondThread {
        PondThread(id: "t1", title: "x", starter: "me", starterName: "Me", state: "working", sessionId: sessionId, updatedAt: now)
    }

    @Test func aStartedSharedPondThreadOpensItsDuckNotThePond() {
        let t = thread(sessionId: nil)
        let at = StartedThreadOpen.destination(thread: t, pond: pond, pondId: "p-id", local: StartedThreadOpen.localKey(of: t, among: [chat]))
        #expect(at == .pondThread(pond: pond, pondId: "p-id", threadId: "t1"))
        #expect(at != .pondHome(pond: pond))
    }

    @Test func aStartedFolderPondThreadOpensItsChatWhenListed() {
        let t = thread(sessionId: "s1")
        let local = StartedThreadOpen.localKey(of: t, among: [chat])
        #expect(local == chat)
        #expect(StartedThreadOpen.destination(thread: t, pond: pond, pondId: "p-id", local: local) == .chat(chat))
        // Not listed yet: still the thread's own page.
        #expect(StartedThreadOpen.destination(thread: t, pond: pond, pondId: "p-id", local: StartedThreadOpen.localKey(of: t, among: []))
                == .pondThread(pond: pond, pondId: "p-id", threadId: "t1"))
    }

    // MARK: Starting… and held messages

    @Test func startingShowsUntilConfirmedAndTheComposerStaysOpen() {
        var s = DuckStart()
        #expect(s.statusLine == nil)
        s.begin(holds: true)
        #expect(s.statusLine == "Starting\u{2026}")
        #expect(s.inputOpen)
        _ = s.confirm()
        #expect(s.statusLine == nil)
    }

    @Test func aStartThatCannotHoldKeepsTheBoxLocked() {
        var s = DuckStart()
        s.begin(holds: false)
        #expect(!s.inputOpen)
        #expect(!held(&s, "hi"))
    }

    @Test func aMessageSentWhileStartingIsHeldAndDeliveredInOrderOnConfirm() {
        var s = DuckStart()
        #expect(!held(&s, "too early"))
        s.begin(holds: true)
        #expect(held(&s, "  first  "))
        #expect(held(&s, "second"))
        #expect(!held(&s, "   "))
        #expect(s.confirm() == ["first", "second"])
        #expect(s.held.isEmpty)
    }

    @Test func aFailureStaysWithOneSentenceKeepsHeldMessagesAndRetries() {
        var s = DuckStart()
        s.begin(holds: true)
        s.hold("keep me")
        s.fail("The host did not answer.")
        #expect(s.failure == "The host did not answer.")
        #expect(s.canRetry && !s.isStarting && s.statusLine == nil)
        #expect(s.held == ["keep me"])
        #expect(DuckStart.retryLabel == "Try again")
        s.begin(holds: true)
        #expect(s.failure == nil && s.isStarting)
        #expect(s.confirm() == ["keep me"])
    }

    // MARK: First minutes: new Pond, start a Duck, send at once

    @Test func newPondStartADuckSendAtOnceNeverLandsAnywhereElse() {
        // The Pond was just made; the Mac's directory read is older and does not list it yet.
        var fresh = FreshPonds()
        fresh.add(pond, at: now)
        let stale: Set<String> = ["old-pond"]
        let live = { fresh.live(directory: stale, now: now.addingTimeInterval(3)) }

        // The Pond's page, then its New duck page (opened from it, so Esc returns to it).
        var back = WorkbenchLocation.home
        var at = WorkbenchLocation.pondHome(pond: pond)
        back = .returnPlace(afterShowing: at, current: back)
        #expect(at.prune(livePonds: live()) == at)
        at = .compose(.newThread, pond: pond, workspace: nil)
        back = .returnPlace(afterShowing: at, current: back)
        #expect(back == .pondHome(pond: pond))

        // Start: the page stays, says Starting…, and a message sent at once is held, however slow the directory is.
        var duck = DuckStart()
        duck.begin(holds: true)
        #expect(at.prune(livePonds: live()) == at)
        #expect(duck.statusLine == "Starting\u{2026}")
        #expect(held(&duck, "and one more thing"))
        #expect(at.prune(livePonds: live()) == at)

        // The host confirms: the Duck's page opens and the held message goes to it.
        #expect(WorkbenchLocation.chat(chat).prune(livePonds: live()) == .chat(chat))
        #expect(duck.confirm() == ["and one more thing"])
    }
}
