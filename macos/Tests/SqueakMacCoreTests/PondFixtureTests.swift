import Foundation
import Testing
@testable import SqueakMacCore

// The real answers of the engine's pond routes (Fixtures/ponds, made by scripts/make-pond-fixtures.ts from two Macs
// and a web guest over one store), decoded through PondsClient. They pin what the views read: when a route's shape
// changes, regenerate the files and these tests say what the Mac must follow.

private func fixture(_ name: String) throws -> String {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "ponds"))
    return try String(contentsOf: url, encoding: .utf8)
}

private final class Replay: HTTPTransport, @unchecked Sendable {
    var status = 200
    var body = "{}"
    private(set) var requests: [HTTPRequest] = []
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
    func serve(_ name: String, status: Int = 200) throws -> Replay { self.status = status; body = try fixture(name); return self }
}

private func client(_ t: Replay) -> PondsClient {
    PondsClient(host: NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, lineSource: { _ in AsyncThrowingStream { $0.finish() } }))
}

@Suite("Pond routes, real answers")
struct PondFixtureTests {
    @Test func createAndListCarryTheLocalProjectId() async throws {
        let made = try #require(try await client(Replay().serve("create")).create(name: "Orchard", projectId: "proj-1"))
        #expect(made.name == "Orchard" && made.role == .owner && made.projectId == "proj-1" && made.gitRemote == "git@github.com:acme/orchard.git")
        #expect(made.memberCount == 1 && made.tint?.hasPrefix("#") == true)
        let list = try #require(try await client(Replay().serve("list")).ponds())
        #expect(list.count == 1 && list[0].projectId == "proj-1")
        #expect(list[0].memberCount == 3 && list[0].threadCount == 2)
    }

    @Test func inviteHasACodeALinkAndATime() async throws {
        let invite = try await client(Replay().serve("invite")).invite(pond: "p", role: .member)
        #expect(invite.code.hasPrefix("squeak-pond:") && invite.expiresAt != nil)
        #expect(invite.link?.hasPrefix("https://squeak.example/join#") == true)
        #expect(invite.link?.hasSuffix(String(invite.code.dropFirst("squeak-pond:".count))) == true)
    }

    @Test func joinIsPendingAndAnOwnerSeesTheRequestWithNestOrNot() async throws {
        let joined = try await client(Replay().serve("join")).join(code: "c", displayName: "Aarav")
        #expect(joined.isPending && !joined.pondId.isEmpty)
        let d = try #require(try await client(Replay().serve("detail-with-joins")).detail(id: "p"))
        #expect(d.myRole == .owner && d.members.count == 1)
        #expect(d.joins.count == 2)
        let aarav = try #require(d.joins.first { $0.name == "Aarav" })
        let vera = try #require(d.joins.first { $0.name == "Vera" })
        #expect(aarav.role == .member && aarav.nest == "Aarav's Mac" && !aarav.isWeb && !aarav.id.isEmpty)
        #expect(vera.role == .viewer && vera.nest == nil && vera.isWeb)
        #expect(PondHomeThreads.needsYouCount(d) == 2)
    }

    @Test func aJoinerWaitingForApprovalGets409InTheHostsWords() async throws {
        do { _ = try await client(try Replay().serve("detail-pending-joiner", status: 409)).detail(id: "p"); Issue.record("should throw") }
        catch NativeHostError.http(409, let message) { #expect(message?.contains("waiting for an owner") == true) }
    }

    @Test func theMemberViewHasMePresenceHoldsAndAMemberWithNoNest() async throws {
        let d = try #require(try await client(Replay().serve("detail-member")).detail(id: "p"))
        #expect(d.myRole == .member && d.me?.name == "Aarav" && d.me?.nest == "Aarav's Mac")
        #expect(d.meMember?.you == true && d.meMember?.id == d.me?.id)
        #expect(d.members.map(\.name) == ["Sibhi", "Aarav", "Vera"])
        let vera = try #require(d.members.first { $0.name == "Vera" })
        #expect(vera.nest == nil && vera.role == .viewer)
        // A member with no Nest reads as a web guest, not a blank.
        #expect(PondFlock.line(for: vera, presence: d.presence, threads: d.threads) == "Viewer \u{00B7} Web")
        let aarav = try #require(d.members.first { $0.you })
        let thread = try #require(d.threads.first)
        #expect(d.presence.contains { $0.member == aarav.id && $0.viewing == thread.id && $0.isTyping(in: thread.id) })
        #expect(PondFlock.line(for: aarav, presence: d.presence, threads: d.threads).hasPrefix("Typing"))
        #expect(PondFlock.typingLine(in: thread.id, members: d.members, presence: d.presence, excluding: d.me?.id) == nil)
        #expect(PondFlock.typingLine(in: thread.id, members: d.members, presence: d.presence, excluding: "someone-else") == "Aarav is typing")
        #expect(d.holds.count == 1 && d.holds[0].byName == "Aarav" && d.holds[0].by == aarav.id && d.holds[0].until != nil)
        #expect(d.ripples.first?.text == "Sibhi shared Scratch" && d.ripples.first?.at != nil)
    }

    @Test func threadsCarryWhatTheViewsRead() async throws {
        let d = try #require(try await client(Replay().serve("detail-owner")).detail(id: "p"))
        let shared = try #require(d.threads.first { $0.title == "Fix irrigation" })
        #expect(shared.mode == .shared && shared.agent == "claude" && shared.model == "opus-5" && shared.starterName == "Sibhi")
        #expect(shared.nest == "Sibhi's Mac" && shared.updatedAt != nil && !shared.isPrivate)
        #expect(shared.permissionMode == "default")
        #expect(PondThreadState(raw: shared.state) == .working)
        // The owner's own private thread comes back to the owner with sessionId and private set.
        let secret = try #require(d.threads.first { $0.title == "Scratch" })
        #expect(secret.isPrivate && secret.sessionId != nil && secret.agent == "codex")
        // The member's view of the same pond never has the private one nor a sessionId.
        let m = try #require(try await client(Replay().serve("detail-member")).detail(id: "p"))
        #expect(m.threads.map(\.title) == ["Fix irrigation"] && m.threads[0].sessionId == nil)
    }

    @Test func eventsDecodeInOrderAndResume() async throws {
        let page = try await client(Replay().serve("events")).events(pond: "p", thread: "t", after: 0)
        #expect(page.events.map(\.seq) == [1, 2, 3, 4, 5] && page.lastSeq == 5)
        guard case .user(let by, let text) = page.events[0].kind else { Issue.record("user"); return }
        #expect(by?.isEmpty == false && text == "Fix the irrigation timer")
        guard case .agent(let said) = page.events[1].kind else { Issue.record("agent"); return }
        #expect(said == "Looking at the timer.")
        guard case .tool(let label, let state) = page.events[2].kind else { Issue.record("tool"); return }
        #expect(label == "Read timer.ts" && state == "running")
        guard case .state(let s) = page.events[3].kind else { Issue.record("state"); return }
        #expect(s == "working")
        guard case .question(let id, let q, let options) = page.events[4].kind else { Issue.record("question"); return }
        #expect(!id.isEmpty && q == "Which port?" && options == ["3000", "4000"])
        let rest = try await client(Replay().serve("events-resume")).events(pond: "p", thread: "t", after: 3)
        #expect(rest.events.map(\.seq) == [4, 5])
    }

    @Test func aMessageQueuesOnSomeoneElsesThreadButNotOnYourOwn() async throws {
        #expect(try await client(Replay().serve("message")).send(pond: "p", thread: "t", text: "x", mode: .queue).state == .queued)
        #expect(try await client(Replay().serve("message-own")).send(pond: "p", thread: "t", text: "x", mode: .steer).state == .sent)
    }

    @Test func aHeldQuestionSaysWhoHoldsItOnHoldAndOnAnswer() async throws {
        let held = try await client(Replay().serve("hold")).hold(pond: "p", thread: "t", requestId: "q")
        #expect(held.ok && held.heldBy == "Aarav")
        let refused = try await client(try Replay().serve("hold-conflict", status: 409)).hold(pond: "p", thread: "t", requestId: "q")
        #expect(!refused.ok && PondHolds.refused(by: refused.heldBy) == "Aarav is answering")
        let answer = try await client(try Replay().serve("answer-conflict", status: 409)).answer(pond: "p", thread: "t", requestId: "q", answer: "3000")
        #expect(answer == .held("Aarav is answering"))
    }

    @Test func okAnswersAreJustOk() async throws {
        let t = try Replay().serve("approve")
        try await client(t).decideJoin(pond: "p", request: "j", approve: true, role: .member)
        _ = try await client(try Replay().serve("presence")).presence(pond: "p", viewing: "t", typingIn: "t")
        try await client(try Replay().serve("visibility")).setPrivate(pond: "p", thread: "t", isPrivate: false)
        try await client(try Replay().serve("remove-member")).removeMember(pond: "p", member: "m")
        #expect(t.requests.count == 1)
    }

    @Test func presenceSendsTheThreadIdForTypingAndNothingWhenQuiet() async throws {
        let t = Replay()
        try await client(t).presence(pond: "p", viewing: "t1", typingIn: "t1")
        try await client(t).presence(pond: "p", viewing: "t1", typingIn: nil)
        try await client(t).presence(pond: "p", viewing: "", typingIn: nil)
        func body(_ i: Int) -> NativeJSON? { t.requests[i].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) } }
        #expect(body(0)?["typing"]?.string == "t1" && body(0)?["viewing"]?.string == "t1")
        #expect(body(1)?["typing"] == nil && body(1)?["viewing"]?.string == "t1")
        #expect(body(2)?["viewing"] == nil && body(2)?["typing"] == nil)
    }

    @Test func shareAnswersTheThread() async throws {
        struct R: Decodable { var thread: PondThread }
        let shared = try JSONDecoder().decode(R.self, from: Data(try fixture("share").utf8)).thread
        #expect(shared.title == "Fix irrigation" && shared.sessionId != nil && shared.mode == .shared && shared.permissionMode == "default")
        let priv = try JSONDecoder().decode(R.self, from: Data(try fixture("share-private").utf8)).thread
        #expect(priv.isPrivate)
    }

    @Test func aProjectFindsItsPondByIdNotByName() throws {
        struct L: Decodable { var ponds: [PondSummary] }
        let list = try JSONDecoder().decode(L.self, from: Data(try fixture("list").utf8)).ponds
        let projects = [NativeProject(id: "proj-1", name: "Renamed locally", rootPath: "/w/orchard", defaultBranch: "main")]
        #expect(PondLookup.pond(in: list, projectName: "Renamed locally", projects: projects)?.name == "Orchard")
        // Another project that happens to share the pond's name is not it.
        let other = [NativeProject(id: "proj-2", name: "Orchard", rootPath: "/w/other", defaultBranch: "main")]
        #expect(PondLookup.pond(in: list, projectName: "Orchard", projects: other) == nil)
        // A pond joined by invite has no project here and is found by name.
        let joined = [PondSummary(id: "j", name: "Shared", role: .member)]
        #expect(PondLookup.pond(in: joined, projectName: "shared", projects: [])?.id == "j")
    }
}

@Suite("Start a thread")
struct PondStartThreadTests {
    @Test func aPondWithAGitRemoteStartsAndOneWithoutOffersOnlySharing() {
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .member, gitRemote: "git@x:o.git")) == .start)
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .owner)) == .shareOnly(why: PondStartThread.noRemote))
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .owner, gitRemote: "  ")) == .shareOnly(why: PondStartThread.noRemote))
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .viewer, gitRemote: "git@x:o.git")) == PondStartThread.none)
        // The host's own word wins: a project held on this Mac starts with no remote; a false one is share-only.
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .owner, projectId: "x", canStartHere: true)) == .start)
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .member, gitRemote: "git@x:o.git", canStartHere: false)) == .shareOnly(why: PondStartThread.noRemote))
        #expect(PondStartThread.offer(for: PondSummary(id: "p", name: "O", role: .viewer, canStartHere: true)) == PondStartThread.none)
        #expect(PondStartThread.noRemote.filter { $0 == "." }.count == 1)
    }

    @Test func theFirstListedModelIsTheDefault() {
        let m = [DaemonChatModel(id: "opus", agent: "claude", label: "Opus", levels: []), DaemonChatModel(id: "gpt", agent: "codex", label: "GPT", levels: [])]
        #expect(PondStartThread.defaultModel(in: m)?.id == "opus" && PondStartThread.defaultModel(in: []) == nil)
    }

    @Test func startThreadSendsTheContractsBodyAndReadsTheThread() async throws {
        let t = Replay()
        t.body = try fixture("share")
        let thread = try await client(t).startThread(pond: "p", text: "Fix it", agent: "claude", model: "opus-5")
        #expect(thread?.title == "Fix irrigation")
        #expect(t.requests[0].method == "POST" && t.requests[0].url.path == "/native/ponds/p/threads")
        let body = t.requests[0].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) }
        #expect(body?["text"]?.string == "Fix it" && body?["agent"]?.string == "claude" && body?["model"]?.string == "opus-5")
    }

    @Test func startThreadSendsEffortModeSplitAndPrivateInOneCall() async throws {
        let t = Replay()
        t.body = try fixture("share")
        _ = try await client(t).startThread(pond: "p", text: "Fix it", agent: "claude", model: "opus-5", workspaceId: "w",
                                            effort: "high", permissionMode: "plan", split: WorkSplit(code: "haiku", run: nil), isPrivate: true)
        #expect(t.requests.count == 1)
        let body = t.requests[0].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) }
        #expect(body?["effort"]?.string == "high" && body?["permissionMode"]?.string == "plan" && body?["workspaceId"]?.string == "w")
        #expect(body?["split"]?["code"]?.string == "haiku" && body?["private"] == .bool(true))
        let plain = Replay(); plain.body = try fixture("share")
        _ = try await client(plain).startThread(pond: "p", text: "x", agent: "claude", model: "m")
        let b2 = plain.requests[0].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) }
        #expect(b2?["private"] == nil && b2?["split"] == nil && b2?["effort"] == nil)
    }

    @Test func joinWaitingIsReadFromTheHostsList() throws {
        let body = #"{"v":1,"p":"abc123","n":"Orchard","r":"viewer"}"#
        let code = "squeak-pond:" + Data(body.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        #expect(PondJoinWaiting.pondId(inInvite: code) == "abc123")
        #expect(PondJoinWaiting.pondId(inInvite: "https://x.web.app/join#" + code.dropFirst(12)) == "abc123")
        #expect(PondJoinWaiting.pondId(inInvite: "nonsense") == nil)
        let waiting = PondSummary(id: "abc123", name: "Orchard", role: .viewer, status: "pending", requestedRole: .member)
        let declined = PondSummary(id: "d", name: "Barn", status: "denied")
        let active = PondSummary(id: "a", name: "Mine")
        // The same invite again finds its waiting request; an active or unknown pond does not.
        #expect(PondJoinWaiting.pending(forInvite: code, in: [active, waiting])?.id == "abc123")
        #expect(PondJoinWaiting.pending(forInvite: code, in: [active]) == nil)
        #expect(PondJoinWaiting.rows([active, waiting, declined]).map(\.id) == ["abc123", "d"])
        #expect(PondJoinWaiting.rowTitle(waiting) == "Orchard \u{00B7} Waiting for approval")
        #expect(PondJoinWaiting.rowTitle(declined) == "Barn \u{00B7} Your request was declined")
        #expect(PondJoinWaiting.asked(waiting) == "Asked to join as a member")
        var now = waiting; now.status = "active"
        #expect(PondJoinWaiting.approved(old: [waiting, active], new: [now, active]).map(\.id) == ["abc123"])
        #expect(PondJoinWaiting.approved(old: [now], new: [now]).isEmpty)
        // The host's list decodes the new fields; an older host's list reads as active.
        let json = #"{"id":"p","name":"N","role":"viewer","status":"pending","requestedRole":"member"}"#
        let decoded = try JSONDecoder().decode(PondSummary.self, from: Data(json.utf8))
        #expect(decoded.isWaiting && decoded.requestedRole == .member)
        #expect(try JSONDecoder().decode(PondSummary.self, from: Data(#"{"id":"p","name":"N","role":"owner"}"#.utf8)).status == "active")
    }
}

@Suite struct PondThreadEntryTests {
    private func ws(_ id: String, _ project: String, branch: String = "b", state: String = "ready", at: Double = 0) -> NativeWorkspace {
        let json = #"{"id":"\#(id)","projectId":"\#(project)","name":"\#(id)","path":"/x/\#(id)","branch":"\#(branch)","state":"\#(state)"}"#
        return try! JSONDecoder().decode(NativeWorkspace.self, from: Data(json.utf8))
    }

    @Test func opensTheNormalPageOnTheNewestStream() {
        let pond = PondSummary(id: "p", name: "Site", gitRemote: "git@x:y.git", projectId: "proj", canStartHere: true)
        let r = PondThreadEntry.resolve(pond: pond, workspaces: [ws("a", "proj"), ws("b", "proj"), ws("z", "other")],
                                        lastActive: ["b": Date(timeIntervalSince1970: 50)])
        guard case .open(let page, let c) = r else { Issue.record("not open"); return }
        #expect(page == .thread(projectId: "proj", workspaceId: "b"))
        #expect(c.choice == .existing("b") && c.showsPicker && !c.isPrivate)
    }

    @Test func noStreamsMeansANewOne() {
        let pond = PondSummary(id: "p", name: "Site", projectId: "proj", canStartHere: true)
        guard case .open(let page, let c) = PondThreadEntry.resolve(pond: pond, workspaces: [ws("a", "proj", state: "archived")]) else { Issue.record("x"); return }
        #expect(page == .thread(projectId: "proj", workspaceId: nil) && c.choice == .new)
    }

    @Test func aPlainFolderHasNoPicker() {
        let pond = PondSummary(id: "p", name: "Site", projectId: "proj", canStartHere: true)
        guard case .open(_, let c) = PondThreadEntry.resolve(pond: pond, workspaces: [ws("a", "proj", branch: "")]) else { Issue.record("x"); return }
        #expect(!c.showsPicker && c.choice == .new)
    }

    @Test func refusesWithAReason() {
        let none = PondSummary(id: "p", name: "Site", canStartHere: false)
        #expect(PondThreadEntry.resolve(pond: none, workspaces: []) == .refuse(why: PondStartThread.noRemote))
        let noProject = PondSummary(id: "p", name: "Site", canStartHere: true)
        #expect(PondThreadEntry.resolve(pond: noProject, workspaces: []) == .refuse(why: PondStartThread.noRemote))
    }

    @Test func theShareLine() {
        #expect(PondThreadEntry.shareLine(pond: "Site", isPrivate: false) == "Shared with Site \u{00B7} everyone in the pond can see it")
        #expect(PondThreadEntry.shareLine(pond: "Site", isPrivate: true).hasPrefix("Private"))
    }
}
