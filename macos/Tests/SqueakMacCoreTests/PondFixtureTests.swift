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
        #expect(list[0].memberCount == 3 && list[0].threadCount == 1)
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
        #expect(PondFlock.line(for: vera, presence: d.presence, threads: d.threads) == "Away \u{00B7} Viewer \u{00B7} Web")
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

    @Test func messagesQueueOnSomeoneElsesThreadOnlyWhenTheStarterIsAway() async throws {
        #expect(try await client(Replay().serve("message")).send(pond: "p", thread: "t", text: "x", mode: .queue) == true)
        #expect(try await client(Replay().serve("message-own")).send(pond: "p", thread: "t", text: "x", mode: .steer) == true)
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
        let list = try JSONDecoder().decode([String: [PondSummary]].self, from: Data(try fixture("list").utf8))["ponds"] ?? []
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
