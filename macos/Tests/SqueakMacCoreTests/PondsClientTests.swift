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

    @Test func aJoinReadsItsDecisionWhileTheHostWorksAndAfterItFails() throws {
        func join(_ decision: String) throws -> JoinRequest {
            try JSONDecoder().decode(JoinRequest.self, from: Data(#"{"requestId":"j","name":"Mira","role":"viewer","decision":\#(decision)}"#.utf8))
        }
        let working = try join(#"{"state":"working","approve":true}"#)
        #expect(working.isDeciding && working.decisionLine == "Approving\u{2026}")
        #expect(try join(#"{"state":"working","approve":false}"#).decisionLine == "Declining\u{2026}")
        let failed = try join(#"{"state":"failed","approve":true,"error":"The relay would not give that member access; try again."}"#)
        #expect(!failed.isDeciding && failed.decisionLine == "The relay would not give that member access; try again.")
        let plain = try JSONDecoder().decode(JoinRequest.self, from: Data(#"{"requestId":"j","name":"Mira"}"#.utf8))
        #expect(plain.decisionLine == nil && !plain.isDeciding)
    }

    @Test func createInviteJoinAndDecideSendTheContractsBodies() async throws {
        let t = PondStub(body: #"{"pond":{"id":"p9","name":"New"},"code":"abc.def","expiresAt":1789000000,"pondId":"p9","status":"pending"}"#)
        let c = client(t)
        let pond = try await c.create(name: "New", projectId: "pr1", rootPath: "/w/new")
        #expect(pond.id == "p9")
        let invite = try await c.invite(pond: "p9", role: .viewer)
        #expect(invite.code == "abc.def" && invite.expiresAt != nil)
        let joined = try await c.join(code: "abc.def")
        #expect(joined.isPending && joined.pondId == "p9")
        try await c.decideJoin(pond: "p9", request: "j1", approve: true, role: .member)
        try await c.removeMember(pond: "p9", member: "m2")
        let paths = t.requests.map { "\($0.method) \($0.url.path)" }
        #expect(paths == ["POST /native/ponds", "POST /native/ponds/p9/invites", "POST /native/ponds/join", "POST /native/ponds/p9/joins/j1", "DELETE /native/ponds/p9/members/m2"])
        func body(_ i: Int) -> NativeJSON? { t.requests[i].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) } }
        #expect(body(0)?["projectId"]?.string == "pr1" && body(0)?["rootPath"]?.string == "/w/new")
        #expect(body(1)?["role"]?.string == "viewer")
        #expect(body(2)?["displayName"] == nil)
        #expect(body(3)?["approve"]?.bool == true)
    }

    @Test func rotateKeySendsThePondIdTheHostDemands() async throws {
        let t = PondStub(body: #"{"ok":true}"#)
        try await client(t).rotateKey(pond: "p9")
        #expect(t.requests[0].method == "POST" && t.requests[0].url.path == "/native/ponds/p9/rotate-key")
        let body = t.requests[0].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) }
        #expect(body?["pondId"]?.string == "p9")
    }

    @Test func threadRoutes() async throws {
        let t = PondStub(body: #"{"ok":true,"queued":true,"events":[{"seq":3,"type":"agent","text":"hi"},{"seq":4,"type":"future-thing"}],"lastSeq":4}"#)
        let c = client(t)
        let page = try await c.events(pond: "p", thread: "t", after: 2)
        #expect(page.events.map(\.seq) == [3, 4] && page.lastSeq == 4)
        #expect(t.requests[0].url.query == "after=2")
        #expect(try await c.send(pond: "p", thread: "t", text: "go", mode: .steer).state == .queued)
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

    @Test func deviceFieldsDecodeAndAreOptional() throws {
        let m = try JSONDecoder().decode(FlockMember.self, from: Data(#"{"id":"m","name":"Me","you":true,"devices":3,"ownDevices":[{"id":"k1","client":"mac","nestName":"Studio","addedAt":1789000000000,"current":true},{"id":"k2","client":"web"},{"client":"ios"}]}"#.utf8))
        #expect(m.devices == 3 && m.ownDevices?.map(\.id) == ["k1", "k2"] && m.ownDevices?[0].current == true && m.ownDevices?[0].addedAt != nil)
        let old = try JSONDecoder().decode(FlockMember.self, from: Data(#"{"id":"m","name":"Me"}"#.utf8))
        #expect(old.devices == nil && old.ownDevices == nil && PondDevices.countLine(old) == nil)
        #expect(PondDevices.countLine(m) == "3 devices")
        #expect(PondDevices.countLine(FlockMember(id: "x", name: "X")) == nil)
    }

    @Test func deviceLabelsAndRemovalRule() {
        #expect(PondDevices.label(PondOwnDevice(id: "a", client: "mac", nestName: "Studio", current: true)) == "This Mac \u{00B7} Studio")
        #expect(PondDevices.label(PondOwnDevice(id: "b", client: "mac")) == "Mac")
        #expect(PondDevices.label(PondOwnDevice(id: "c", client: "web")) == "Browser")
        #expect(PondDevices.label(PondOwnDevice(id: "d", client: "ios")) == "iPhone")
        let now = Date()
        #expect(PondDevices.added(PondOwnDevice(id: "e", client: "web", addedAt: now.addingTimeInterval(-3 * 86400)), now: now)?.hasPrefix("added ") == true)
        #expect(PondDevices.added(PondOwnDevice(id: "e", client: "web"), now: now) == nil)
        #expect(!PondDevices.canRemove([PondOwnDevice(id: "a", client: "mac")]))
        #expect(PondDevices.canRemove([PondOwnDevice(id: "a", client: "mac"), PondOwnDevice(id: "b", client: "web")]))
    }

    @Test func removeMineAndSyncAccountSendTheContractsBodies() async throws {
        let t = PondStub(body: #"{"ok":true,"asked":2}"#)
        let c = client(t)
        try await c.removeMyDevice(pond: "p1", deviceKeyId: "k2")
        #expect(t.requests[0].url.path == "/native/ponds/p1/devices/remove-mine" && t.requests[0].method == "POST")
        #expect(String(decoding: t.requests[0].body ?? Data(), as: UTF8.self).contains(#""deviceKeyId":"k2""#))
        #expect(try await c.syncAccount() == 2)
        #expect(t.requests[1].url.path == "/native/ponds/sync-account")
        #expect(t.requests[0].headers["x-squeak-token"] == "tok")
        #expect(try await client(PondStub(status: 404)).syncAccount() == nil)
    }
}
