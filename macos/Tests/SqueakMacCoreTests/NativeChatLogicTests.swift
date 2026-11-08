import XCTest
@testable import SqueakMacCore

final class NativeChatLogicTests: XCTestCase {
    func testModesMapAndCycle() {
        XCTAssertEqual(NativeModes.composerMode("default"), .ask)
        XCTAssertEqual(NativeModes.composerMode("bypassPermissions"), .skipApprovals)
        XCTAssertEqual(NativeModes.permissionMode(.acceptEdits), "acceptEdits")
        XCTAssertEqual(NativeModes.next(after: .ask), .acceptEdits)
        XCTAssertEqual(NativeModes.next(after: .acceptEdits), .plan)
        XCTAssertEqual(NativeModes.next(after: .plan), .ask)
        XCTAssertEqual(NativeModes.next(after: .skipApprovals), .ask)
        XCTAssertEqual(NativeModes.modeAfterPlanApproval(current: "plan"), "acceptEdits")
        XCTAssertNil(NativeModes.modeAfterPlanApproval(current: "bypassPermissions"))
    }

    func testBashApprovalCard() {
        let r = NativeRequest(id: "r1", kind: "tool", payload: .parse(#"{"toolName":"Bash","input":{"command":"rm -rf x","description":"Clearing the cache"},"title":"Run a command that deletes a folder"}"#)!)
        let c = NativeCards.card(r, agent: "Claude")
        XCTAssertEqual(c.kind, .approval)
        XCTAssertEqual(c.approval?.tool, "Bash")
        XCTAssertEqual(c.approval?.command, "rm -rf x")
        XCTAssertEqual(c.approval?.reason, "Clearing the cache")
        XCTAssertEqual(c.approval?.heading, "Run a command that deletes a folder")
    }

    func testEditApprovalShowsPathNotCommand() {
        let r = NativeRequest(id: "r1", kind: "tool", payload: .parse(#"{"toolName":"Edit","input":{"file_path":"/a/b.ts"}}"#)!)
        let c = NativeCards.card(r, agent: "Claude")
        XCTAssertNil(c.approval?.command)
        XCTAssertEqual(c.approval?.target, "/a/b.ts")
        XCTAssertEqual(c.approval?.heading, "Claude wants to use Edit")
    }

    func testPlanAndQuestionCards() {
        let plan = NativeRequest(id: "p", kind: "plan", payload: .parse(###"{"toolName":"ExitPlanMode","input":{"plan":"## Do it\n1. a"}}"###)!)
        XCTAssertEqual(NativeCards.card(plan, agent: "Claude").plan?.markdown, "## Do it\n1. a")
        let q = NativeRequest(id: "q", kind: "question", payload: .parse(#"{"toolName":"AskUserQuestion","input":{"questions":[{"question":"Which?","options":[{"label":"A (Recommended)","description":"x"},{"label":"B"}]}]}}"#)!)
        let c = NativeCards.card(q, agent: "Claude")
        XCTAssertEqual(c.kind, .question)
        XCTAssertEqual(c.question?.options.map(\.title), ["A", "B"])
        XCTAssertEqual(c.question?.options.first?.recommended, true)
        XCTAssertEqual(c.questionTexts, ["Which?"])
    }

    func testCodexCommandCard() {
        let r = NativeRequest(id: "c", kind: "command", payload: .parse(#"{"command":"/bin/zsh -lc 'npm test'","reason":"run tests"}"#)!)
        let c = NativeCards.card(r, agent: "Codex")
        XCTAssertEqual(c.approval?.command, "npm test")
        XCTAssertEqual(c.approval?.reason, "run tests")
    }

    func testOldestRequestIsTheCard() {
        let a = NativeRequest(id: "new", kind: "tool", payload: .null, createdAt: Date(timeIntervalSince1970: 200))
        let b = NativeRequest(id: "old", kind: "tool", payload: .null, createdAt: Date(timeIntervalSince1970: 100))
        XCTAssertEqual(NativeCards.card(for: [a, b], agent: "Claude")?.id, "old")
        XCTAssertNil(NativeCards.card(for: [], agent: "Claude"))
    }

    func testQuestionFlowCollectsAnswers() {
        var f = NativeQuestionFlow(texts: ["Q1", "Q2"])
        XCTAssertFalse(f.answer("A"))
        XCTAssertTrue(f.answer("B"))
        XCTAssertEqual(f.json, .object(["Q1": .string("A"), "Q2": .string("B")]))
    }

    func testLiveStateStreamsAndDedupes() {
        var s = NativeLiveState()
        let delta = NativeJSON.parse(#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"#)!
        XCTAssertEqual(s.apply(.delta(delta)), .none)
        _ = s.apply(.delta(.parse(#"{"method":"item/agentMessage/delta","delta":"lo"}"#)!))
        XCTAssertEqual(s.streamingText, "Hello")
        let m = NativeMessage(seq: 5, role: "agent", kind: "assistant", payload: .null)
        XCTAssertEqual(s.apply(.message(m)), .transcriptChanged)
        XCTAssertEqual(s.streamingText, "")
        XCTAssertEqual(s.apply(.message(m)), .none)
        XCTAssertEqual(s.apply(.reset(lastSeq: 9, prunedThrough: 0)), .refetch)
        XCTAssertEqual(s.apply(.message(m)), .transcriptChanged)
    }

    func testLiveStateRequestsAndQueue() {
        var s = NativeLiveState()
        let r = NativeRequest(id: "r", kind: "tool", payload: .null)
        _ = s.apply(.request(r)); _ = s.apply(.request(r))
        XCTAssertEqual(s.requests.count, 1)
        _ = s.apply(.requestResolved("r"))
        XCTAssertTrue(s.requests.isEmpty)
        _ = s.apply(.queueChanged)
        XCTAssertTrue(s.takeQueueDirty())
        XCTAssertFalse(s.takeQueueDirty())
    }

    func testSteerRefusedNote() {
        XCTAssertEqual(NativeQueueNote.steerRefused("can't steer", agent: "Claude"), "Claude can't steer mid-turn; it reads this after the turn.")
        XCTAssertEqual(NativeQueueNote.steerRefused("other", agent: "Claude"), "other")
    }

    func testNewChatFormRequests() {
        var f = NativeNewChatForm()
        let p = NativeProject(id: "p1", name: "squeak", rootPath: "/r", defaultBranch: "main")
        f.setProjects([p])
        f.setModels([
            DaemonChatModel(id: "opus", agent: "claude", label: "Opus", levels: ["low", "high"], defaultLevel: "high"),
            DaemonChatModel(id: "gpt", agent: "codex", label: "GPT", levels: ["medium"], defaultLevel: "medium"),
        ])
        XCTAssertNil(f.request)
        f.text = "  do it "
        var r = f.request
        XCTAssertEqual(r?.model, "opus"); XCTAssertEqual(r?.effort, "high")
        XCTAssertEqual(r?.newWorkspace, true); XCTAssertEqual(r?.projectId, "p1"); XCTAssertEqual(r?.text, "do it")
        XCTAssertEqual(r?.permissionMode, "default")
        f.place = .projectFolder
        r = f.request
        XCTAssertEqual(r?.cwd, "/r"); XCTAssertEqual(r?.newWorkspace, false)
        f.choose(agent: .codex)
        XCTAssertEqual(f.request?.model, "gpt")
        f.mode = .plan
        XCTAssertEqual(f.request?.permissionMode, "plan")
        f.place = .existing("nope")
        XCTAssertFalse(f.canStart)
    }

    func testTitleFallback() {
        XCTAssertEqual(NativeTitles.fallback(title: nil, firstMessage: nil), "New chat")
        XCTAssertEqual(NativeTitles.fallback(title: " ", firstMessage: "Fix it\nmore"), "Fix it")
        XCTAssertEqual(NativeTitles.fallback(title: "T", firstMessage: "x"), "T")
    }
}
