import Foundation
import Testing
@testable import SqueakMacCore

// Replay tests for the Mac's native-chat model layer. Each one scripts what the session host says over time (rows,
// statuses, pending items, requests), drives the person's presses, and asserts what the chat shows after every step:
// the working line and its words, Stop, the queue stack's cards, the steps under each bubble, the helpers, the draft.
// The pieces are described in ChatScreen.swift; the scenarios are the bugs the owner reported.

private struct World {
    let clock: FakeClock
    let host: FakeNativeHost
    let screen: ChatScreen
    let chat = "c1"
}

private func world(agent: String = "claude", daemonDown: Bool = false) async -> World {
    let clock = FakeClock(maxTicks: 100_000)
    let host = FakeNativeHost(clock: clock)
    host.addChat("c1", agent: agent)
    let cache = EncryptedCache(configuration: .init(directory: tempDirectory()), keyStore: MemoryKeyStore())
    let screen = ChatScreen(host: host, clock: clock, agent: agent, cache: cache, daemonDown: daemonDown)
    await screen.launch()
    await screen.open()
    return World(clock: clock, host: host, screen: screen)
}

private func accepted(_ r: SendResult?) -> Bool { if case .accepted? = r { true } else { false } }

private func texts(_ s: ChatScreen) -> [String] { s.shownMessages.map(\.text) }

/// The folds by the text of the message each sits before.
private func foldsByText(_ s: ChatScreen) -> [String: String] {
    Dictionary(uniqueKeysWithValues: s.folds.compactMap { id, title in s.shownMessages.first { $0.id == id }.map { ($0.text, title) } })
}

/// How many steps each fold holds, by the text of the message it sits before (the title's "for 2s" depends on the clock).
private func foldedSteps(_ s: ChatScreen) -> [String: Int] {
    foldsByText(s).mapValues { Int($0.split(separator: " ").dropLast().last ?? "") ?? -1 }
}

struct TypedMessageReplay {
    @Test func aTypedMessageWorksThenFoldsItsStepsUnderTheReply() async {
        let w = await world()
        let s = w.screen, h = w.host
        #expect(s.workingLine == nil && !s.stopShown)

        #expect(accepted(await s.send("fix the bug")))
        #expect(s.workingLine == "Working…" && s.stopShown)
        #expect(s.roundButton == .stop)

        await s.deliver(h.think("c1", "look at the failing test"), h.tool("c1", toolId: "t1", name: "Read", input: ["file_path": "/tmp/work/a.swift"]))
        #expect(s.liveSteps == ["Thinking: look at the failing test", "Read a.swift"])
        #expect(s.workingLine == "Working…" && s.folds.isEmpty)

        await s.deliver(h.say("c1", "Fixed it."), h.setStatus("c1", "idle", turnEnded: true))
        #expect(s.workingLine == nil && !s.stopShown && s.liveSteps.isEmpty)
        #expect(texts(s) == ["fix the bug", "Fixed it."])
        #expect(foldsByText(s) == ["Fixed it.": "Worked · 2 steps"])
    }
}

struct SteerReplay {
    @Test func aSteerOnCodexSaysSteeringUntilTheAgentTakesItIn() async {
        let w = await world(agent: "codex")
        let s = w.screen, h = w.host
        h.onSend = { host, id, text, mode in
            guard mode == .steer, host.chat(id).status == "working" else { return host.defaultSend(id, text, mode) }
            host.user(id, text)
            let seq = host.chat(id).rows.last?["seq"] as? Int
            host.addPending(id, "p1", text: text, state: "steering", seq: seq)
            return false
        }
        await s.send("start the migration")
        await s.deliver(h.say("c1", "Starting."))

        #expect(accepted(await s.send("and run the tests", mode: .steer)))
        #expect(s.cards == ["Steering…: and run the tests"])
        // Its transcript row stays out of the transcript while the card shows.
        #expect(texts(s) == ["start the migration", "Starting."])
        #expect(s.workingLine == "Working…")

        await s.deliver(h.removePending("c1", "p1", consumed: true, seq: s.pending.host.first?.seq))
        #expect(s.cards.isEmpty)
        #expect(texts(s) == ["start the migration", "Starting.", "and run the tests"])
    }

    @Test func aSteerWaitingOnAHelperSaysSoThenSteeringThenGoes() async {
        let w = await world(agent: "codex")
        let s = w.screen, h = w.host
        await s.send("start")
        h.user("c1", "also tests")
        let seq = h.chat("c1").rows.last?["seq"] as? Int
        await s.deliver(h.addPending("c1", "p1", text: "also tests", state: "steering", seq: seq, waitingFor: "helper"))
        #expect(s.cards == ["Waiting for helper…: also tests"])
        // The helper reports in: the host drops the marker, it is a plain steer again.
        await s.deliver(h.removePending("c1", "p1", consumed: false), h.addPending("c1", "p1", text: "also tests", state: "steering", seq: seq))
        #expect(s.cards == ["Steering…: also tests"])
        await s.deliver(h.removePending("c1", "p1", consumed: true, seq: seq))
        #expect(s.cards.isEmpty)
    }

    @Test func aSteerClaudeCannotTakeIsQueuedNotSteering() async {
        let w = await world()
        let s = w.screen, h = w.host
        h.onSend = { host, id, text, mode in
            guard host.chat(id).status == "working" else { return host.defaultSend(id, text, mode) }
            host.addPending(id, "q1", text: text, state: "queued")
            return true
        }
        await s.send("start")
        let r = await s.send("also add tests", mode: .steer)
        guard case .accepted(_, let delivery, let note)? = r else { Issue.record("not accepted: \(String(describing: r))"); return }
        #expect(delivery == .queued && note?.contains("can't take a message mid-turn") == true)
        #expect(s.cards == ["Queued: also add tests"])

        // The turn ends and the host starts the queued message as the next turn.
        await s.deliver(h.say("c1", "Done."), h.setStatus("c1", "idle", turnEnded: true))
        await s.deliver(h.removePending("c1", "q1", consumed: true), h.user("c1", "also add tests"), h.setStatus("c1", "working"))
        #expect(s.cards.isEmpty)
        #expect(texts(s) == ["start", "Done.", "also add tests"])
        #expect(s.workingLine == "Working…")
    }

    /// Steer stuck on "Steering…": the host queued the message and took it in before it ever listed it, so no pending
    /// item arrives to replace the Mac's own card. It was a steer card that never left.
    @Test func aSendTheHostNeverListsDoesNotSitAsASteeringCard() async {
        let w = await world()
        let s = w.screen, h = w.host
        h.onSend = { host, id, text, mode in
            guard host.chat(id).status == "working" else { return host.defaultSend(id, text, mode) }
            return true  // queued, and gone from the host's list again before anyone asked
        }
        await s.send("start")
        await s.send("one more thing", mode: .steer)
        #expect(!s.cards.contains { $0.hasPrefix("Steering…") })
        s.tick(6)
        #expect(s.cards.isEmpty)
    }

    @Test func aHostEventAfterTheGraceAlsoClearsASettledCard() async {
        let w = await world()
        let s = w.screen, h = w.host
        h.onSend = { host, id, text, mode in
            guard host.chat(id).status == "working" else { return host.defaultSend(id, text, mode) }
            return true
        }
        await s.send("start")
        await s.send("later", mode: .queue)
        w.clock.advance(8)
        await s.deliver(h.addPending("c1", "other", text: "something else", state: "queued"))
        #expect(s.cards == ["Queued: something else"])
    }
}

struct StopReplay {
    /// Working after Stop: Stop pressed before the agent wrote a word. The newest message is still the person's, and a
    /// guess for sources that cannot say ("a send within 3 minutes with no reply is starting") read the stopped chat as working.
    @Test func stoppingBeforeAnyReplyEndsTheWorkingLine() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("do the whole thing")
        #expect(s.workingLine == "Working…" && s.stopShown)

        await s.stop()
        // The host says so itself: cancelling is still working.
        #expect(s.workingLine != nil)
        await s.deliver(h.setStatus("c1", "cancelling"))
        await s.deliver(h.interrupted("c1"), h.aborted("c1"), h.setStatus("c1", "idle", turnEnded: true))
        #expect(s.workingLine == nil && !s.stopShown)
        #expect(s.roundButton == .send)
        w.clock.advance(60)
        #expect(s.workingLine == nil)
    }

    @Test func stoppingEndsTheMacsOwnWorkingFromThePressEvenBeforeTheHostSaidAnything() async {
        let w = await world()
        let s = w.screen
        // The host is slow: the send is accepted but its rows and statuses have not reached the Mac.
        w.host.onSend = { _, _, _, _ in false }
        await s.send("go")
        #expect(s.workingLine == "Working…")
        await s.stop()
        #expect(s.optimistic == nil)
    }

    @Test func aStatusFromTheStreamReachesTheLineEvenWhenTheInfoReadFails() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("go")
        await s.deliver(h.say("c1", "On it."))
        h.down = true  // the info read after a status frame fails while the host restarts
        let idle = h.setStatus("c1", "idle", turnEnded: true)
        await s.deliver(idle)
        #expect(s.info?.status == "idle")
        #expect(s.workingLine == nil && !s.stopShown)
    }

    @Test func helpersAreStoppedWithTheTurnAndTheWaitingLineGoes() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("scan the repo with a helper")
        await s.deliver(
            h.tool("c1", toolId: "ag1", name: "Agent", input: ["description": "scan repo", "prompt": "p", "run_in_background": true]),
            h.toolResult("c1", toolId: "ag1", "Async agent launched successfully. agentId: a1", extra: ["tool_use_result": ["status": "async_launched"]]),
            h.addRow("c1", role: "system", kind: "system/task_started", ["task_id": "a1", "tool_use_id": "ag1"]),
            h.say("c1", "Waiting on the helper."), h.setStatus("c1", "waiting", background: 1, turnEnded: true))
        #expect(s.workingLine == "Waiting for 1 background task")
        #expect(s.stopShown)
        #expect(s.helpers().count == 1 && s.helpers()[0].running && s.helpers()[0].label.contains("scan repo"))

        await s.stop()
        await s.deliver(h.interrupted("c1"), h.aborted("c1"), h.setStatus("c1", "idle", background: 0, turnEnded: true))
        #expect(s.workingLine == nil && !s.stopShown)
        #expect(s.helpers().count == 1 && !s.helpers()[0].running)
        // The helper's row in the finished turn reads stopped too, not running.
        #expect(s.helpers(inTurnOf: "scan the repo with a helper").allSatisfy { !$0.running })
    }

    @Test func helpersThatFinishLetTheWaitingLineGoWithoutAStop() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("go")
        await s.deliver(h.say("c1", "Waiting."), h.setStatus("c1", "waiting", background: 2, turnEnded: true))
        #expect(s.workingLine == "Waiting for 2 background tasks")
        await s.deliver(h.say("c1", "Both helpers are done."), h.setStatus("c1", "idle", background: 0, turnEnded: true))
        #expect(s.workingLine == nil)
    }
}

struct DraftReplay {
    /// Draft lost when options appear: the lettered option answers the agent and sends only its letter. What is typed in
    /// the composer, and the picture beside it, are a different message and stay: in the app, in the saved draft, and
    /// after a relaunch.
    @Test func aDraftAndItsPictureSurviveAnOptionsCardAndTheAnswer() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("pick a colour")
        await s.deliver(h.say("c1", "Which one?\n\nA) Red\nB) Blue"), h.setStatus("c1", "idle", turnEnded: true))

        s.draft = "half a thought"
        s.tray = ["shot.png"]
        await s.broker.setDraft(s.draft, for: s.key)  // the 600 ms debounce fired

        await s.deliver(
            h.askQuestion("c1", rid: "r1", question: "Which colour?", options: ["Red", "Blue"]), h.setStatus("c1", "needs_user_input"))
        #expect(s.card?.kind == .question)
        #expect(s.draft == "half a thought" && s.tray == ["shot.png"])
        #expect(await s.broker.draft(for: s.key) == "half a thought")

        // Tapping the lettered option on the card sends the letter.
        #expect(accepted(await s.send("B", answering: true)))
        #expect(s.draft == "half a thought" && s.tray == ["shot.png"])
        #expect(await s.broker.draft(for: s.key) == "half a thought")
        #expect(s.workingLine == "Working…")

        // The app quits and comes back: the draft is still there.
        let again = s.relaunched()
        await again.launch()
        await again.open()
        #expect(again.draft == "half a thought")
    }

    @Test func answeringTheQuestionCardLeavesTheDraftAlone() async {
        let w = await world()
        let s = w.screen, h = w.host
        s.draft = "typing while it asks"
        await s.broker.setDraft(s.draft, for: s.key)
        await s.deliver(h.askQuestion("c1", rid: "r1", question: "Which?", options: ["Red", "Blue"]), h.setStatus("c1", "needs_user_input"))
        await s.answerCard(option: "Red")
        #expect(s.card == nil && s.draft == "typing while it asks")
        #expect(await s.broker.draft(for: s.key) == "typing while it asks")
    }

    @Test func anOrdinarySendClearsTheDraftEverywhere() async {
        let w = await world()
        let s = w.screen
        s.draft = "ship it"
        await s.broker.setDraft(s.draft, for: s.key)
        await s.send("ship it")
        #expect(s.draft.isEmpty)
        #expect(await s.broker.draft(for: s.key) == nil)
    }
}

struct HistoryReplay {
    private func twoTurns(_ w: World) async {
        let s = w.screen, h = w.host
        await s.send("first")
        await s.deliver(
            h.think("c1", "plan"), h.tool("c1", toolId: "t1", name: "Read", input: ["file_path": "/tmp/work/a.swift"]),
            h.say("c1", "one"), h.setStatus("c1", "idle", turnEnded: true))
        await s.send("second")
        await s.deliver(
            h.tool("c1", toolId: "t2", name: "Edit", input: ["file_path": "/tmp/work/a.swift", "old_string": "a", "new_string": "b"]),
            h.say("c1", "two"), h.setStatus("c1", "idle", turnEnded: true))
    }

    @Test func aRelaunchedAppShowsTheHistoryAtOnceAndTheStepsOnceTheHostAnswers() async {
        let w = await world()
        await twoTurns(w)
        #expect(foldedSteps(w.screen) == ["one": 2, "two": 1])

        let again = w.screen.relaunched()
        await again.launch()
        // Before any read of the host: the cached transcript.
        #expect(await again.broker.messages(for: again.key).map(\.text) == ["first", "one", "second", "two"])
        await again.open()
        #expect(texts(again) == ["first", "one", "second", "two"])
        #expect(foldedSteps(again) == ["one": 2, "two": 1])
        #expect(again.workingLine == nil)
    }

    @Test func aRelaunchWhileTheHostIsDownStillShowsTheWords() async {
        let w = await world()
        await twoTurns(w)
        w.host.down = true
        let again = w.screen.relaunched()
        await again.launch()
        await again.open()
        #expect(texts(again) == ["first", "one", "second", "two"])
        #expect(again.workingLine == nil)
    }

    @Test func aRelaunchDuringATurnPicksTheRunningTurnUp() async {
        let w = await world()
        await twoTurns(w)
        await w.screen.send("third")
        await w.screen.deliver(w.host.tool("c1", toolId: "t3", name: "Bash", input: ["command": "swift test"]))
        let again = w.screen.relaunched()
        await again.launch()
        await again.open()
        #expect(again.workingLine == "Working…" && again.stopShown)
        #expect(again.liveSteps == ["Run swift test"])
        #expect(Set(foldsByText(again).keys) == ["one", "two"])
    }
}

struct AnswerReplay {
    /// The steps keep showing after an option on a question card is answered: the chat reads working from the press,
    /// and the next tool calls list as live steps. (wt-liverow works on the view side of this; this is the model's half.)
    @Test func stepsAreLiveRightAfterAnAnswer() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("set it up")
        await s.deliver(h.tool("c1", toolId: "t1", name: "Read", input: ["file_path": "/tmp/work/a.swift"]))
        await s.deliver(h.askQuestion("c1", rid: "r1", question: "Which?", options: ["Red", "Blue"]), h.setStatus("c1", "needs_user_input"))
        #expect(s.card?.kind == .question)
        #expect(s.workingLine == "")

        await s.answerCard(option: "Red")
        #expect(s.card == nil && s.workingLine == "Working…")

        await s.deliver(h.requestResolvedEvent("r1"), h.setStatus("c1", "working"), h.tool("c1", toolId: "t2", name: "Edit", input: ["file_path": "/tmp/work/b.swift", "old_string": "a", "new_string": "b"]))
        #expect(s.workingLine == "Working…")
        #expect(s.liveSteps == ["Read a.swift", "Edit b.swift"])
    }
}

struct ResilienceReplay {
    @Test func aNativeChatStaysUsableWhileTheDaemonRestarts() async {
        let w = await world(daemonDown: true)
        let s = w.screen
        #expect(s.catalog.contains { $0.key == s.key })
        #expect(accepted(await s.send("hello")))
        #expect(texts(s) == ["hello"])
        #expect(s.workingLine == "Working…")
        await s.deliver(w.host.say("c1", "Hi."), w.host.setStatus("c1", "idle", turnEnded: true))
        #expect(texts(s) == ["hello", "Hi."] && s.workingLine == nil)
        #expect(w.host.log.filter { $0 == "POST /native/sessions/c1/messages" }.count == 1)
    }

    @Test func aHostThatBlipsDuringASendGetsTheMessageOnce() async {
        let w = await world()
        w.host.failNextSends = 2
        #expect(accepted(await w.screen.send("once please")))
        #expect(w.host.chat("c1").rows.filter { $0["kind"] as? String == "user/text" }.count == 1)
        #expect(texts(w.screen) == ["once please"])
    }

    @Test func aSendThatNeverReachesTheHostGivesTheWordsBackAndNoWorkingLine() async {
        let w = await world()
        let s = w.screen
        w.host.failNextSends = 3
        s.draft = "keep me"
        let r = await s.send("keep me")
        guard case .notSent? = r else { Issue.record("expected notSent, got \(String(describing: r))"); return }
        #expect(s.draft == "keep me")
        #expect(s.workingLine == nil && !s.stopShown && s.optimistic == nil)
        #expect(s.shownMessages.last?.state == .notSent(reason: "Squeak's session host isn't running"))
        // The host is back: the person sends again.
        s.draft = ""
        #expect(accepted(await s.send("keep me")))
        #expect(s.workingLine == "Working…")
    }
}

struct TurnsReplay {
    /// Steps stay under the bubble that began them: a typed message, an answer to the agent's options, a steer.
    @Test func eachTurnsStepsFoldUnderTheRightBubble() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("first typed")
        await s.deliver(
            h.think("c1", "plan"), h.tool("c1", toolId: "t1", name: "Read", input: ["file_path": "/tmp/work/a.swift"]),
            h.say("c1", "one\n\nA) Red\nB) Blue"), h.setStatus("c1", "idle", turnEnded: true))
        await s.send("B", answering: true)
        await s.deliver(
            h.tool("c1", toolId: "t2", name: "Edit", input: ["file_path": "/tmp/work/a.swift", "old_string": "a", "new_string": "b"]),
            h.say("c1", "two"), h.setStatus("c1", "idle", turnEnded: true))
        await s.send("long job")
        await s.deliver(h.tool("c1", toolId: "t3", name: "Bash", input: ["command": "swift build"]))
        // The person steers: the agent takes the message in and carries on.
        await s.deliver(h.user("c1", "also run the tests"))
        await s.deliver(
            h.tool("c1", toolId: "t4", name: "Edit", input: ["file_path": "/tmp/work/c.swift", "old_string": "a", "new_string": "b"]),
            h.say("c1", "three"), h.setStatus("c1", "idle", turnEnded: true))

        let f = foldsByText(s)
        #expect(f["one\n\nA) Red\nB) Blue"] == "Worked · 2 steps")
        #expect(f["two"]?.hasSuffix("· 1 step") == true)
        // The steps before the steer sit above the steer's bubble: a turn that wrote no message of its own is not lost.
        #expect(f["also run the tests"]?.hasSuffix("· 1 step") == true)
        #expect(f["three"]?.hasSuffix("· 1 step") == true)
        #expect(f.count == 4)
    }

    @Test func theRunningTurnListsTheNewestSixAndFoldsOlderOnes() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("big job")
        for n in 1...8 {
            await s.deliver(h.tool("c1", toolId: "t\(n)", name: "Read", input: ["file_path": "/tmp/work/f\(n).swift"]))
        }
        let block = TurnFolding.block(steps: s.activity, working: true)
        #expect(block.foldTitle == "Worked · 2 steps")
        #expect(block.shown.count == 6)
        #expect(s.folds.isEmpty)
    }
}

struct PictureReplay {
    @Test func pictureTokensDrawAsPicturesNotText_NowAndAfterARelaunch() async {
        let w = await world()
        let s = w.screen
        let text = ImageAttachments.compose("look at this", refs: ["/tmp/work/shot.png"])
        #expect(accepted(await s.send(text)))
        // The host's row confirms the send: one bubble, never two.
        #expect(s.shownMessages.filter { $0.role == .user }.count == 1)
        let first = s.bubble(s.shownMessages[0])
        #expect(first.words == "look at this" && first.pictures == ["/tmp/work/shot.png"])

        let again = s.relaunched()
        await again.launch()
        await again.open()
        let old = again.bubble(again.shownMessages[0])
        #expect(old.words == "look at this" && old.pictures == ["/tmp/work/shot.png"])
    }
}

struct MarksReplay {
    @Test func theSidebarMarkAndTheBannerFollowTheChatThroughApprovalAndFinish() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("go")
        let working = await s.broker.sessions()
        #expect(working.first.flatMap { ChatMark.of($0, unread: false) } == ChatMark(.working))

        h.setStatus("c1", "needs_user_permission")
        await s.broker.refresh()
        let blocked = await s.broker.sessions()
        let events = NotificationPolicy.detect(previous: working, current: blocked)
        #expect(events.count == 1 && events[0].kind == .blocked && events[0].body.hasSuffix("is waiting for your approval"))
        #expect(blocked.first.flatMap { ChatMark.of($0, unread: false) } == ChatMark(.waiting, waiting: .approval))

        h.setStatus("c1", "working")
        h.say("c1", "Done.")
        h.setStatus("c1", "idle", turnEnded: true)
        await s.broker.refresh()
        let done = await s.broker.sessions()
        // A Squeak chat finishing is on the sidebar, not a banner.
        #expect(NotificationPolicy.detect(previous: blocked, current: done).isEmpty)
        #expect(done.first.flatMap { ChatMark.of($0, unread: true) } == ChatMark(.unread))
        #expect(done.first.flatMap { ChatMark.of($0, unread: false) } == nil)
    }
}

/// A steer is one card in the stream: dimmed at the bottom while the agent has not taken it in, solid in place once it has,
/// the steps flowing beneath it, and nothing folds while the chain runs.
struct InlineSteerReplay {
    private func steerOnCodex(_ h: FakeNativeHost) {
        h.onSend = { host, id, text, mode in
            guard mode == .steer, host.chat(id).status == "working" else { return host.defaultSend(id, text, mode) }
            host.user(id, text, steered: true)
            let seq = host.chat(id).rows.last?["seq"] as? Int
            host.addPending(id, "p1", text: text, state: "steering", seq: seq)
            return false
        }
    }

    @Test func aWaitingSteerIsDimInlineThenSolidInPlaceWithTheStepsBelow() async {
        let w = await world(agent: "codex")
        let s = w.screen, h = w.host
        steerOnCodex(h)
        await s.send("start the migration")
        await s.deliver(h.tool("c1", toolId: "t1", name: "Read", input: ["file_path": "/tmp/work/a.swift"]), h.say("c1", "Reading."))

        #expect(accepted(await s.send("and run the tests", mode: .steer)))
        // Waiting: one dim card inline (not in the queue stack), its row not yet in the transcript, the work still listed.
        #expect(s.inlineSteers.map(\.text) == ["and run the tests"] && s.inlineSteers[0].caption == nil)
        #expect(s.stackCards.isEmpty)
        #expect(texts(s) == ["start the migration", "Reading."])
        #expect(s.folds.isEmpty && s.workingLine == "Working…")

        // The agent takes it in: the same card is solid, in its place in the transcript, and the next steps come after it.
        await s.deliver(h.removePending("c1", "p1", consumed: true, seq: s.pending.host.first?.seq))
        #expect(s.inlineSteers.isEmpty)
        #expect(texts(s) == ["start the migration", "Reading.", "and run the tests"])
        #expect(s.shownMessages.last?.steered == true)
        await s.deliver(h.tool("c1", toolId: "t2", name: "Bash", input: ["command": "swift test"]))
        #expect(s.liveSteps.count == 2 && s.liveSteps.last?.contains("swift test") == true)
        #expect(s.folds.isEmpty)

        await s.deliver(h.say("c1", "All green."), h.setStatus("c1", "idle", turnEnded: true))
        // One fold for the whole chain, only now.
        #expect(foldedSteps(s) == ["Reading.": 2])
    }

    @Test func aSteerWaitingOnAHelperCarriesTheCaptionOnTheDimCard() async {
        let w = await world(agent: "codex")
        let s = w.screen, h = w.host
        await s.send("start")
        h.user("c1", "also tests", steered: true)
        let seq = h.chat("c1").rows.last?["seq"] as? Int
        await s.deliver(h.addPending("c1", "p1", text: "also tests", state: "steering", seq: seq, waitingFor: "helper"))
        #expect(s.inlineSteers.map(\.caption) == ["Waiting for helper…"])
        #expect(s.stackCards.isEmpty)
        await s.deliver(h.removePending("c1", "p1", consumed: false), h.addPending("c1", "p1", text: "also tests", state: "steering", seq: seq))
        #expect(s.inlineSteers.map(\.caption) == [nil])
    }

    @Test func nothingFoldsWhileASteerIsWaitingEvenWhenTheTurnEndedUnderIt() async {
        let w = await world(agent: "codex")
        let s = w.screen, h = w.host
        steerOnCodex(h)
        await s.send("go")
        await s.deliver(h.tool("c1", toolId: "t1", name: "Read", input: ["file_path": "/tmp/work/a.swift"]), h.say("c1", "Looking."))
        await s.send("one more", mode: .steer)
        // Claude ends the old turn before it takes the steer in: the gap between the two must not fold the work away.
        await s.deliver(h.setStatus("c1", "idle", turnEnded: true))
        #expect(s.folds.isEmpty)
    }
}

struct DucklingsReplay {
    private func item(_ id: String, _ title: String, _ status: String = "running", summary: String? = nil) -> [String: Any] {
        var d: [String: Any] = ["id": id, "kind": "agent", "title": title, "model": "Sonnet 5.5", "status": status,
                                "startedAt": FakeNativeHost.iso(Date(timeIntervalSince1970: 1_700_000_000))]
        if let summary { d["summary"] = summary }
        return d
    }

    @Test func aTurnThatEndsWithHelpersRunningIsReadyAndASendStartsATurn() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("review everything with two helpers")
        h.setDucklings("c1", items: [item("task-aaaa1111", "Review src"), item("task-bbbb2222", "Review docs")])
        await s.deliver(h.say("c1", "Two helpers are on it."), h.setStatus("c1", "idle", turnEnded: true))
        await s.refreshInfo()

        #expect(s.info?.ducklings?.running == 2)
        #expect(s.workingLine == nil && !s.stopShown)
        #expect(s.dock.readyLine == "Ready · 2 ducklings running")
        #expect(!s.dock.working && !s.dock.isWorking)
        #expect(ComposerPrompt.placeholder(agent: "Claude", workspace: nil, phase: .idle) == "Tell Claude what to do next")
        #expect(s.roundButton == .send)

        // A new message starts a turn at once, not queued behind the helpers.
        #expect(accepted(await s.send("also check the tests")))
        #expect(s.cards.isEmpty)
        #expect(s.workingLine == "Working…" && s.stopShown)
        #expect(s.dock.readyLine == nil)
    }

    @Test func aHelperThatFinishesTurnsItsChipIntoACheck() async {
        let w = await world()
        let s = w.screen, h = w.host
        h.setDucklings("c1", items: [item("task-aaaa1111", "Review src"), item("task-bbbb2222", "Review docs")])
        await s.deliver(h.setStatus("c1", "idle", turnEnded: true))
        await s.refreshInfo()
        #expect(s.info?.ducklings?.items.map(\.chipMark) == [nil, nil])

        h.setDucklings("c1", items: [item("task-aaaa1111", "Review src", "done", summary: "All good"), item("task-bbbb2222", "Review docs")])
        await s.refreshInfo()
        let set = s.info?.ducklings
        #expect(set?.running == 1)
        #expect(set?.items.map(\.chipMark) == ["✓", nil])
        #expect(s.dock.readyLine == "Ready · 1 duckling running" && s.workingLine == nil)

        h.setDucklings("c1", items: [item("task-aaaa1111", "Review src", "done"), item("task-bbbb2222", "Review docs", "failed")])
        await s.refreshInfo()
        #expect(s.info?.ducklings?.items.map(\.chipMark) == ["✓", "✕"])
        #expect(s.dock.readyLine == nil && DucklingWords.barText(s.info?.ducklings) == "Background work finished, one failed")
    }

    @Test func aHostWithoutDucklingsKeepsTheOldWaitingLine() async {
        let w = await world()
        let s = w.screen, h = w.host
        await s.send("go")
        await s.deliver(h.say("c1", "Waiting."), h.setStatus("c1", "waiting", background: 2, turnEnded: true))
        #expect(s.workingLine == "Waiting for 2 background tasks")
        #expect(s.dock.readyLine == nil)
    }

    @Test func thePanelModelComesFromTheHostRoute() async throws {
        let w = await world()
        let s = w.screen, h = w.host
        h.setDucklings("c1", items: [item("task-aaaa1111", "Review src")])
        h.setDucklingDetail("c1", task: "task-aaaa1111", [
            "id": "task-aaaa1111", "title": "Review src", "model": "Sonnet 5.5", "status": "done",
            "startedAt": "2026-11-12T10:00:00Z", "endedAt": "2026-11-12T10:04:00Z", "brief": "Read src and list risks.",
            "steps": [["kind": "tool", "text": "Read a.swift"], ["kind": "note", "text": "Looks fine"]], "report": "No risks found.",
        ])
        await s.refreshInfo()
        let chip = s.info?.ducklings?.items.first
        let detail = try await s.hostClient.duckling(sessionId: "c1", taskId: "task-aaaa1111")
        let panel = DucklingPanelModel.make(result: .success(detail), chip: chip)
        #expect(panel.body == .ready && panel.status == .done && !panel.isLive)
        #expect(panel.title == "Review src" && panel.model == "Sonnet 5.5")
        #expect(panel.brief == "Read src and list risks." && panel.report == "No risks found.")
        #expect(panel.steps.map(\.text) == ["Read a.swift", "Looks fine"])
        #expect(panel.message == nil)
        // An unknown task is a 404: the panel says the service is older, and a failed read keeps what it had.
        let missing = try await s.hostClient.duckling(sessionId: "c1", taskId: "task-zzzz9999")
        #expect(missing == nil && DucklingPanelModel.make(result: .success(missing), chip: chip).body == .unavailable)
        struct Boom: Error {}
        #expect(DucklingPanelModel.make(result: .failure(Boom()), chip: chip, previous: panel).body == .ready)
    }
}
