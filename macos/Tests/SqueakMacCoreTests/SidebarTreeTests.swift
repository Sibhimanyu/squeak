import Foundation
import Testing
@testable import SqueakMacCore

private func chat(_ id: String, _ title: String, provider: String = "conductor", repo: String = "squeak", branch: String? = nil,
                  cwd: String? = nil, workspace: String? = nil, state: SessionState = .finished, ago: TimeInterval = 60,
                  now: Date) -> HostSession {
    HostSession(key: SessionKey(provider: provider, workspaceId: workspace, hostSessionId: id), title: title, repoName: repo,
                branch: branch, cwd: cwd, agent: provider.hasPrefix("codex") ? "codex" : "claude", state: state,
                lastActivityAt: now.addingTimeInterval(-ago), alive: true, conductorWorkspaceId: workspace)
}

@Suite("Sidebar tree")
struct SidebarTreeTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func projectsWorkspacesAndChatsAreNewestFirst() {
        let list = [
            chat("1", "a", cwd: "/w/squeak/mallard", ago: 900, now: now),
            chat("2", "b", cwd: "/w/squeak/heron", ago: 30, now: now),
            chat("3", "c", cwd: "/w/squeak/mallard", ago: 100, now: now),
            chat("4", "d", repo: "blume", cwd: "/w/blume/x", ago: 5, now: now),
        ]
        let t = SidebarTreeBuilder.build(list, now: now)
        #expect(t.projects.map(\.name) == ["blume", "squeak"])
        let squeak = t.projects[1]
        #expect(squeak.workspaces.map(\.name) == ["heron", "mallard"])
        #expect(squeak.workspaces[1].chats.map(\.title) == ["c", "a"])
    }

    @Test func aWaitingChatKeepsItsPlaceAndTheFoldedRowShowsItsMark() {
        let list = [
            chat("1", "quiet", cwd: "/w/squeak/mallard", ago: 10, now: now),
            chat("2", "asks", cwd: "/w/squeak/mallard", state: .blocked, ago: 500, now: now),
        ]
        let t = SidebarTreeBuilder.build(list, now: now)
        // The blocked chat keeps its place (older, so second) in the tree: no group, no move.
        #expect(t.projects[0].workspaces[0].chats.map(\.title) == ["quiet", "asks"])
        #expect(t.projects[0].workspaces[0].foldedMark == FoldedMark(mark: ChatMark(.waiting, waiting: .answer), count: 1))
        #expect(t.projects[0].foldedMark?.mark.kind == .waiting)
    }

    @Test func foldedMarkIsWaitingThenFailedThenUnreadThenWorkingAndQuietShowsNone() {
        let w = SidebarTreeBuilder.build([
            chat("1", "w", cwd: "/a", state: .working, now: now),
            chat("2", "d", cwd: "/a", state: .finished, now: now),
            chat("3", "e", cwd: "/b", state: .error, now: now),
            chat("4", "i", cwd: "/c", state: .idle, ago: 120, now: now),
            chat("5", "r", cwd: "/d", state: .finished, now: now),
        ], now: now, isUnread: { $0.title == "d" }).projects[0].workspaces
        #expect(w.first { $0.name == "a" }?.foldedMark?.mark.kind == .unread)
        #expect(w.first { $0.name == "b" }?.foldedMark?.mark.kind == .failed)
        #expect(w.first { $0.name == "d" }?.foldedMark == nil)  // finished and read: the age shows
        let c = w.first { $0.name == "c" }
        #expect(c != nil && c?.foldedMark == nil)
    }

    @Test func nativeChatsGroupByRepoAndFolderWithoutAConductorChip() throws {
        let json = """
        {"active":[{"key":"claude:abc","agent":"claude","origin":"squeak","state":"working","title":"Fix it",
        "repoName":"squeak","branch":"sib/mallard","cwd":"/w/squeak/mallard","replyTarget":"claude:abc"}]}
        """
        let native = try JSONDecoder().decode(DaemonState.self, from: Data(json.utf8)).sessions.map { DaemonAdapter.map($0) }[0]
        #expect(native.key.provider == "claude-squeak")
        #expect(native.source == .squeak)
        #expect(native.origin == .squeakManaged)
        #expect(!native.showsConductorBadge)
        let cond = chat("9", "c", cwd: "/w/squeak/mallard", workspace: "ws1", now: now)
        let t = SidebarTreeBuilder.build([native, cond], now: now)
        #expect(t.projects.map(\.name) == ["squeak"])
        // Native chat is grouped by its folder; Conductor's by its workspace id: two workspaces, one project.
        #expect(t.projects[0].workspaces.count == 2)
        #expect(t.place(of: native.key)?.workspace.branch == "sib/mallard")
        #expect(cond.showsConductorBadge)
    }

    @Test func earlierChatsStayOffUnlessOpen() {
        let old = chat("1", "old", state: .idle, ago: 3 * 86_400, now: now)
        #expect(SidebarTreeBuilder.build([old], now: now).projects.isEmpty)
        #expect(SidebarTreeBuilder.build([old], now: now, keeping: old.key).place(of: old.key) != nil)
    }

    @Test func relativeAge() {
        #expect(RelativeAge.short(now.addingTimeInterval(-10), now: now) == "now")
        #expect(RelativeAge.short(now.addingTimeInterval(-300), now: now) == "5m")
        #expect(RelativeAge.short(now.addingTimeInterval(-7200), now: now) == "2h")
        #expect(RelativeAge.short(now.addingTimeInterval(-3 * 86_400), now: now) == "3d")
        #expect(RelativeAge.short(now.addingTimeInterval(-15 * 86_400), now: now) == "2w")
        #expect(RelativeAge.short(nil, now: now) == "")
    }
}

@Suite("Chat title")
struct ChatTitleTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func fallbackTitleShowsTheFirstMessageOrNewChat() {
        let s = chat("1", "squeak · mallard", branch: "sibhi/mallard", cwd: "/w/squeak/mallard", now: now)
        #expect(ChatTitle.isFallback(s))
        #expect(ChatTitle.resolve(s, headline: "squeak · mallard", firstMessage: "  Fix the\nsplitter  ") == "Fix the splitter")
        #expect(ChatTitle.resolve(s, headline: "squeak · mallard", firstMessage: nil) == "New chat")
        let long = String(repeating: "word ", count: 30)
        #expect(ChatTitle.resolve(s, headline: "x", firstMessage: long).count <= 61)
    }

    @Test func aRealTitleIsLeftAlone() {
        let named = chat("2", "Fix the splitter", cwd: "/w/squeak/mallard", now: now)
        #expect(ChatTitle.resolve(named, headline: "Fix the splitter", firstMessage: "hello") == "Fix the splitter")
    }
}

@Suite("Native workspace names")
struct NativeWorkspaceNameTests {
    @Test func nativeWorkspaceNameBeatsTheProjectFolder() {
        var s = HostSession(key: SessionKey(provider: "claude-squeak", hostSessionId: "squeak-native:1"), title: "t", repoName: "squeak",
                            branch: "me/mallard", cwd: "/Users/me/squeak", state: .finished, lastActivityAt: Date(), workspaceName: "mallard")
        let t = SidebarTreeBuilder.build([s], now: Date())
        #expect(t.projects[0].workspaces[0].name == "mallard")
        #expect(t.projects[0].workspaces[0].branchLabel == nil)
        s.workspaceName = nil
        #expect(SidebarTreeBuilder.build([s], now: Date()).projects[0].workspaces[0].name == "squeak")
    }

    @Test func branchShowsOnlyWhenItDiffers() {
        let w = SidebarWorkspace(id: "a", name: "mallard", branch: "feature/x", chats: [], foldedMark: nil)
        #expect(w.branchLabel == "feature/x")
    }

    @Test func adapterUsesTheHostWorkspaceNameElseTheFolder() throws {
        let json = #"{"id":"1","cwd":"/w/squeak/mallard","agent":"claude","model":"m","permissionMode":"default","status":"idle","prunedThrough":0}"#
        let n = try JSONDecoder().decode(NativeSession.self, from: Data(json.utf8))
        #expect(NativeAdapter.map(n, overlay: nil, workspaceName: "teal").workspaceName == "teal")
        #expect(NativeAdapter.map(n, overlay: nil).workspaceName == "mallard")
    }

    @Test func planCardDropsOnlyAPlanHeading() {
        #expect(NativeCards.dropPlanHeading("## Plan\n\n1. a\n2. b") == "1. a\n2. b")
        #expect(NativeCards.dropPlanHeading("# plan\nbody") == "body")
        #expect(NativeCards.dropPlanHeading("## Queue routes\n\nbody") == "## Queue routes\n\nbody")
        #expect(NativeCards.dropPlanHeading("No heading") == "No heading")
    }
}

@Suite("Chat marks")
struct ChatMarkTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func s(_ state: SessionState, ago: TimeInterval = 60, alive: Bool? = true, approval: Bool? = nil, ask: String? = nil) -> HostSession {
        HostSession(key: SessionKey(provider: "t", hostSessionId: "x"), title: "x", state: state,
                    lastActivityAt: now.addingTimeInterval(-ago), alive: alive, awaitingApproval: approval, pendingQuestion: ask)
    }

    @Test func eachStateHasItsMarkAndExactWords() {
        #expect(ChatMark.of(s(.blocked, approval: true), unread: false, now: now)?.words == "Waiting for your approval")
        #expect(ChatMark.of(s(.blocked, ask: "Which one?"), unread: false, now: now)?.words == "Waiting for your answer")
        #expect(ChatMark.of(s(.blocked, ask: PendingQuestion.planDetail), unread: false, now: now)?.words == "Plan ready for your review")
        #expect(ChatMark.of(s(.working), unread: false, now: now)?.words == "Working")
        #expect(ChatMark.of(s(.error), unread: false, now: now)?.words == "Failed")
        #expect(ChatMark.of(s(.finished), unread: true, now: now)?.words == "Finished, not opened yet")
    }

    @Test func readIdleAndDeadChatsShowTheAge() {
        #expect(ChatMark.of(s(.finished), unread: false, now: now) == nil)
        #expect(ChatMark.of(s(.idle), unread: false, now: now) == nil)
        #expect(ChatMark.of(s(.working, alive: false), unread: false, now: now) == nil)
        #expect(ChatMark.of(s(.error, ago: 3 * 86_400), unread: false, now: now) == nil)
    }

    @Test func foldedPriorityAndCount() {
        let top = FoldedMark.top([ChatMark(.working), ChatMark(.unread), ChatMark(.failed), ChatMark(.failed)])
        #expect(top?.mark.kind == .failed && top?.count == 2)
        #expect(top?.words == "Failed, 2 chats")
        #expect(FoldedMark.top([ChatMark(.working), ChatMark(.waiting, waiting: .approval)])?.words == "Waiting for your approval")
        #expect(FoldedMark.top([]) == nil)
        #expect(FoldedMark.combine([FoldedMark(mark: ChatMark(.unread), count: 2), FoldedMark(mark: ChatMark(.working), count: 5)])
            == FoldedMark(mark: ChatMark(.unread), count: 2))
    }
}

@Suite("Chat seen log")
struct ChatSeenLogTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func done(_ ago: TimeInterval, id: String = "a") -> HostSession {
        HostSession(key: SessionKey(provider: "t", hostSessionId: id), title: id, state: .finished,
                    lastActivityAt: now.addingTimeInterval(-ago), alive: true)
    }

    @Test func aFinishIsUnreadUntilOpenedAndANewFinishIsUnreadAgain() {
        var log = ChatSeenLog()
        let first = done(600)
        #expect(log.isUnread(first, now: now))
        log.markOpened(first, now: now)
        #expect(!log.isUnread(first, now: now))
        // The same chat finishes another turn later.
        #expect(log.isUnread(done(30), now: now))
        log.markOpened(done(30), now: now)
        #expect(!log.isUnread(done(30), now: now))
    }

    @Test func onlyRecentFinishesCountAndOnlyFinishedChats() {
        let log = ChatSeenLog()
        #expect(!log.isUnread(done(2 * 86_400), now: now))
        var working = done(5)
        working.state = .working
        #expect(!log.isUnread(working, now: now))
    }

    @Test func whatFinishedBeforeTheLogBeganIsRead() {
        let log = ChatSeenLog(baseline: now.addingTimeInterval(-100))
        #expect(!log.isUnread(done(300), now: now))
        #expect(log.isUnread(done(10), now: now))
    }

    @Test func roundTripsAndStaysBounded() throws {
        var log = ChatSeenLog(baseline: now)
        for i in 0..<(ChatSeenLog.capacity + 30) { log.markOpened(done(Double(i + 1), id: "c\(i)"), now: now) }
        #expect(log.seen.count == ChatSeenLog.capacity)
        #expect(try JSONDecoder().decode(ChatSeenLog.self, from: JSONEncoder().encode(log)) == log)
    }
}

@Suite("Live step line")
struct LiveStepLineTests {
    @Test func namesASingleEditedFileAndFormatsTheElapsedTime() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let steps = [ActivityStep(kind: "tool", text: "Edit src/store.test.ts")]
        #expect(LiveStepLine.step(steps) == "Editing store.test.ts")
        #expect(LiveStepLine.line(steps: steps, since: now.addingTimeInterval(-72), now: now) == "Editing store.test.ts · 1m 12s")
        #expect(LiveStepLine.line(steps: [ActivityStep(kind: "thinking", text: "")], since: now.addingTimeInterval(-40), now: now) == "Thinking · 40s")
        #expect(LiveStepLine.line(steps: [], since: nil, now: now) == "Working")
        let two = [ActivityStep(kind: "tool", text: "Edit a.ts"), ActivityStep(kind: "tool", text: "Edit b.ts")]
        #expect(LiveStepLine.step(two) == "Editing 2 files")
    }
}

@Suite struct DotGridLoaderFrameTests {
    @Test func theCometTurnsOverNineFramesAndHoldsFrameFive() {
        #expect(DotGridFrames.frameCount == 9 && DotGridFrames.heldFrame == 4)
        // Frame 0: dot 0 is the head, the next three trail, the rest are unlit.
        #expect(DotGridFrames.opacities(frame: 0) == [1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.32, 0.5, 0.75])
        #expect(DotGridFrames.opacities(frame: 4) == [0.2, 0.32, 0.5, 0.75, 1, 0.2, 0.2, 0.2, 0.2])
        #expect(DotGridFrames.opacities(frame: 9) == DotGridFrames.opacities(frame: 0))
        #expect(DotGridFrames.frame(at: 0.11 * 3 + 0.001, quiet: false) == 3)
        #expect(DotGridFrames.frame(at: 3.0 / 9 * 2 + 0.001, quiet: true) == 2)
        #expect(DotGridFrames.frame(at: 0.11 * 10 + 0.001, quiet: false) == 1)
    }

    @Test func aBackgroundWaitingChatShowsTheQuietLoader() {
        var s = HostSession(key: SessionKey(provider: "conductor", hostSessionId: "q"), state: .working, alive: true)
        #expect(ChatMark.of(s, unread: false)?.quiet == false)
        s.backgroundWaiting = true
        let mark = ChatMark.of(s, unread: false)
        #expect(mark?.quiet == true && mark?.words == "Waiting for background tasks")
        // A folded row prefers a loader that is really working over a quiet one.
        #expect(FoldedMark.top([mark!, ChatMark(.working)])?.mark.quiet == false)
        #expect(ChatMark(.failed, quiet: true).quiet == false)
    }
}

private func stream(title: String?) -> HostSession {
    HostSession(key: SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: "s1"), cwd: "/w/wood-duck", workspaceName: "wood-duck", workspaceTitle: title)
}

@Suite("Stream titles")
struct StreamTitleTests {
    @Test func titleShowsAndSlugStaysName() {
        let s = stream(title: "Detached HEAD Duck")
        let ws = SidebarTreeBuilder.build([s], keeping: s.key).projects.first?.workspaces.first
        #expect(ws?.name == "wood-duck")
        #expect(ws?.displayTitle == "Detached HEAD Duck")
    }

    @Test func noTitleFallsBackToName() {
        #expect(SidebarTreeBuilder.workspaceDisplayTitle([stream(title: " ")]) == "wood-duck")
    }

    @Test func paletteShowsTitleAndMatchesSlug() {
        let items = CommandPalette.items(sessions: [stream(title: "Detached HEAD Duck")], context: PaletteContext())
        let ws = items.first { $0.group == .workspaces }
        #expect(ws?.title == "Detached HEAD Duck")
        #expect(ws?.keywords.contains("wood-duck") == true)
    }
}
