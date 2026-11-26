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

    @Test func createAndRemoveSendTheContractsBodies() async throws {
        let t = PondStub(body: #"{"pond":{"id":"p9","name":"New"}}"#)
        let c = client(t)
        let pond = try await c.create(name: "New", projectId: "pr1", rootPath: "/w/new")
        #expect(pond.id == "p9")
        try await c.removeMember(pond: "p9", member: "m2")
        try await c.setRole(pond: "p9", member: "m2", role: .viewer)
        let paths = t.requests.map { "\($0.method) \($0.url.path)" }
        #expect(paths == ["POST /native/ponds", "DELETE /native/ponds/p9/members/m2", "POST /native/ponds/p9/members/m2/role"])
        func body(_ i: Int) -> NativeJSON? { t.requests[i].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) } }
        #expect(body(0)?["projectId"]?.string == "pr1" && body(0)?["rootPath"]?.string == "/w/new")
        #expect(body(2)?["role"]?.string == "viewer")
    }

    private static let record = #"{"id":"i1","email":"a@x.co","role":"member","state":"pending","invitedBy":"S","createdAt":1,"expiresAt":2,"settledAt":0}"#

    @Test func peopleReadsTheHostsRouteAndAnAbsentRouteIsNil() async throws {
        let t = PondStub(body: #"{"cap":10,"members":[{"id":"m1","name":"S","email":"s@x.co","role":"owner","online":true,"you":true}],"invites":[\#(Self.record)]}"#)
        let p = try #require(try await client(t).people(pond: "p9"))
        #expect(p.members.count == 1 && p.invites.count == 1 && p.used == 2)
        #expect(t.requests[0].method == "GET" && t.requests[0].url.path == "/native/ponds/p9/people")
        #expect(try await client(PondStub(status: 404, body: #"{"error":"no such route"}"#)).people(pond: "p9") == nil)
    }

    @Test func inviteByEmailSendsEmailsAndRoleAndReadsEachAnswer() async throws {
        let t = PondStub(body: #"{"results":[{"email":"a@x.co","ok":true,"invite":\#(Self.record)},{"email":"b@x.co","ok":false,"message":"Already a Member."}]}"#)
        let r = try await client(t).invite(pond: "p9", emails: ["a@x.co", "b@x.co"], role: .viewer)
        #expect(r.map(\.ok) == [true, false] && r[1].message == "Already a Member.")
        #expect(t.requests[0].method == "POST" && t.requests[0].url.path == "/native/ponds/p9/invites")
        let body = t.requests[0].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) }
        #expect(body?["role"]?.string == "viewer" && body?["emails"]?.array?.compactMap(\.string) == ["a@x.co", "b@x.co"])
    }

    @Test func resendWithdrawAndInviteAgainHitTheirOwnRoutes() async throws {
        let t = PondStub(body: #"{"invite":\#(Self.record)}"#)
        let c = client(t)
        _ = try await c.resendInvite(pond: "p9", invite: "i1")
        _ = try await c.withdrawInvite(pond: "p9", invite: "i1")
        let again = try await c.inviteAgain(pond: "p9", invite: "i1", role: .viewer)
        #expect(again.id == "i1")
        #expect(t.requests.map { "\($0.method) \($0.url.path)" } == [
            "POST /native/ponds/p9/invites/i1/resend", "POST /native/ponds/p9/invites/i1/withdraw", "POST /native/ponds/p9/invites/i1/again"])
        #expect(t.requests[2].body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) }?["role"]?.string == "viewer")
    }

    @Test func aRefusedInviteActionSurfacesTheHostsSentence() async throws {
        let c = client(PondStub(status: 409, body: #"{"error":"That invitation was already answered."}"#))
        do { _ = try await c.withdrawInvite(pond: "p9", invite: "i1"); Issue.record("should throw") }
        catch let e as NativeHostError { #expect(e.reason.contains("already answered")) }
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

    /// #129: nothing about a device is drawn in a pond, so a member carries no device fields; an older host that still
    /// sends them decodes fine and they are ignored.
    @Test func deviceFieldsAreIgnoredNotDrawn() throws {
        let m = try JSONDecoder().decode(FlockMember.self, from: Data(#"{"id":"m","name":"Me","you":true,"devices":3,"ownDevices":[{"id":"k1","client":"mac","current":true}]}"#.utf8))
        #expect(m.id == "m" && m.name == "Me" && m.you)
        let mirror = Mirror(reflecting: m).children.compactMap(\.label)
        #expect(!mirror.contains("devices") && !mirror.contains("ownDevices"))
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
