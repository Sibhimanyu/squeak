import Foundation
import Testing
@testable import SqueakMacCore

private final class PondStub: HTTPTransport, @unchecked Sendable {
    var status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int = 200, body: String = "{}") { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

private func client(_ t: PondStub, lines: @escaping @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> = { _ in AsyncThrowingStream { $0.finish() } }) -> PondsClient {
    PondsClient(host: NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: t, tokenProvider: { "tok" }, lineSource: lines))
}

@Suite("Ponds client")
struct PondsClientTests {
    @Test func aHostWithoutTheRoutesAnswersNilAndNothingElse() async throws {
        let t = PondStub(status: 404, body: #"{"error":"not found"}"#)
        #expect(try await client(t).ponds() == nil)
        #expect(try await client(t).detail(id: "p1") == nil)
    }

    @Test func listDecodesTolerantlyAndSendsTheToken() async throws {
        let t = PondStub(body: #"{"ponds":[{"id":"p1","name":"Orchard","role":"owner","memberCount":3,"threadCount":4,"needsYou":1,"gitRemote":"git@x:o.git","tint":210},{"name":"no id"},{"id":"p2"}]}"#)
        let list = try #require(try await client(t).ponds())
        #expect(list.map(\.id) == ["p1", "p2"])
        #expect(list[0].role == .owner && list[0].memberCount == 3 && list[0].tint == "210" && list[0].gitRemote == "git@x:o.git")
        // Everything but the id may be missing: an unknown role is the least a person can do.
        #expect(list[1].name == "" && list[1].role == .viewer && list[1].needsYou == 0)
        #expect(t.requests[0].headers["x-squeak-token"] == "tok")
        #expect(t.requests[0].url.path == "/native/ponds")
    }

    @Test func aDetailWithOnlyThePondStillDecodes() async throws {
        let d = try #require(try await client(PondStub(body: #"{"pond":{"id":"p1","name":"O"}}"#)).detail(id: "p1"))
        #expect(d.members.isEmpty && d.threads.isEmpty && d.me == nil && d.myRole == .viewer)
    }

    @Test func createInviteJoinAndDecideSendTheContractsBodies() async throws {
        let t = PondStub(body: #"{"pond":{"id":"p9","name":"New"},"code":"abc.def","expiresAt":1789000000,"pondId":"p9","status":"pending"}"#)
        let c = client(t)
        let pond = try await c.create(name: "New", projectId: "pr1", rootPath: "/w/new")
        #expect(pond.id == "p9")
        let invite = try await c.invite(pond: "p9", role: .viewer)
        #expect(invite.code == "abc.def" && invite.expiresAt != nil)
        let joined = try await c.join(code: "abc.def", displayName: "Mira")
        #expect(joined.isPending && joined.pondId == "p9")
        try await c.decideJoin(pond: "p9", request: "j1", approve: true, role: .member)
        try await c.removeMember(pond: "p9", member: "m2")
        let paths = t.requests.map { "\($0.method) \($0.url.path)" }
        #expect(paths == ["POST /native/ponds", "POST /native/ponds/p9/invites", "POST /native/ponds/join", "POST /native/ponds/p9/joins/j1", "DELETE /native/ponds/p9/members/m2"])
        func body(_ i: Int) -> NativeJSON? { t.requests[i].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) } }
        #expect(body(0)?["projectId"]?.string == "pr1" && body(0)?["rootPath"]?.string == "/w/new")
        #expect(body(1)?["role"]?.string == "viewer")
        #expect(body(2)?["displayName"]?.string == "Mira")
        #expect(body(3)?["approve"]?.bool == true)
    }

    @Test func threadRoutes() async throws {
        let t = PondStub(body: #"{"ok":true,"queued":true,"events":[{"seq":3,"type":"agent","text":"hi"},{"seq":4,"type":"future-thing"}],"lastSeq":4}"#)
        let c = client(t)
        let page = try await c.events(pond: "p", thread: "t", after: 2)
        #expect(page.events.map(\.seq) == [3, 4] && page.lastSeq == 4)
        #expect(t.requests[0].url.query == "after=2")
        #expect(try await c.send(pond: "p", thread: "t", text: "go", mode: .steer))
        #expect(t.requests[1].url.path == "/native/ponds/p/threads/t/messages")
        try await c.setPrivate(pond: "p", thread: "t", isPrivate: true)
        try await c.share(pond: "p", sessionId: "s1", isPrivate: false)
        try await c.presence(pond: "p", viewing: "t", typingIn: "t")
        #expect(t.requests.dropFirst(2).map { $0.url.path } == ["/native/ponds/p/threads/t/visibility", "/native/ponds/p/share", "/native/ponds/p/presence"])
    }

    @Test func aHeldQuestionRefusesWithWho() async throws {
        let t = PondStub(status: 409, body: #"{"error":"Aarav is answering"}"#)
        let c = client(t)
        #expect(try await c.answer(pond: "p", thread: "t", requestId: "q", answer: "A") == .held("Aarav is answering"))
        let h = try await c.hold(pond: "p", thread: "t", requestId: "q")
        #expect(!h.ok && h.heldBy == "Aarav is answering")
        t.status = 200; t.body = #"{"ok":true,"heldBy":"m2"}"#
        #expect(try await c.answer(pond: "p", thread: "t", requestId: "q", answer: "A") == .sent)
        #expect(try await c.hold(pond: "p", thread: "t", requestId: "q") == (true, "m2"))
    }

    @Test func changedEventsYieldPondIdsAndNothingElse() async {
        let lines: @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> = { _ in
            AsyncThrowingStream { c in
                for l in ["event: ping", "data: {}", "", "event: changed", #"data: {"pondId":"p1"}"#, "", "event: changed", #"data: {"pondId":"p2"}"#, ""] { c.yield(l) }
                c.finish()
            }
        }
        let stream = client(PondStub(), lines: lines).changes(sleep: { _ in try await Task.sleep(for: .seconds(60)) })
        var got: [String] = []
        for await id in stream { got.append(id); if got.count == 2 { break } }
        #expect(got == ["p1", "p2"])
    }
}
