import Foundation
import Testing
@testable import SqueakMacCore

private final class CloudStub: HTTPTransport, @unchecked Sendable {
    let status: Int, body: String
    private(set) var requests: [HTTPRequest] = []
    init(status: Int, body: String) { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}

@Suite("Squeak cloud (hosted)")
struct CloudLayerTests {
    private func client(_ t: CloudStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }
    private func decode(_ json: String) throws -> CloudState { try JSONDecoder().decode(CloudState.self, from: Data(json.utf8)) }

    @Test func decodesTheFullBlock() throws {
        let s = try decode(#"{"hosted":{"state":"error","email":"a@b.c","error":"Relay unreachable.","legacy":"firebase","moving":false}}"#)
        #expect(s.hosted == HostedCloud(phase: .error, email: "a@b.c", error: "Relay unreachable.", legacy: .firebase, moving: false))
    }

    @Test func decodesAPartialBlock() throws {
        let s = try decode(#"{"hosted":{"state":"ready","legacy":null}}"#)
        #expect(s.hosted?.phase == .ready)
        #expect(s.hosted?.email == nil)
        #expect(s.hosted?.legacy == nil)
    }

    @Test func anAbsentBlockOrUnknownValuesDecodeQuietly() throws {
        #expect(try decode("{}").hosted == nil)
        let h = try decode(#"{"hosted":{"state":"future","legacy":"other"}}"#).hosted
        #expect(h?.phase == nil && h?.legacy == nil)
        #expect(h?.statusSentence() == nil)
    }

    @Test func statusSentencePerState() {
        #expect(HostedCloud(phase: .needsSignIn).statusSentence() == "Sign in to connect")
        #expect(HostedCloud(phase: .connecting).statusSentence() == "Connecting…")
        #expect(HostedCloud(phase: .ready).statusSentence() == "Connected")
        #expect(HostedCloud(phase: .error, error: "Nope.").statusSentence() == "Nope.")
        #expect(HostedCloud(phase: .error).statusSentence() == "Couldn't connect to Squeak's cloud.")
    }

    @Test func knownAccountNeverSaysSignInToConnect() {
        let h = HostedCloud(phase: .needsSignIn, email: "a@b.co", legacy: .catalystOwn, signInUrl: "https://x.test/app/index.html")
        #expect(h.statusSentence(accountKnown: true) == "This Mac isn't connected to Squeak's cloud yet")
        #expect(h.statusSentence(accountKnown: false) == "Sign in to connect")
        #expect(h.actionTitle(accountKnown: true) == "Connect…")
        #expect(h.actionTitle(accountKnown: false) == "Sign in…")
        #expect(h.legacySentence(accountKnown: true) == "This Mac still uses your own Catalyst relay. Connect to move it; paired devices follow.")
        #expect(h.signInUrl == "https://x.test/app/index.html")
    }

    @Test func actionAndStatusByState() {
        #expect(HostedCloud(phase: .connecting).actionTitle(accountKnown: true) == nil)
        #expect(HostedCloud(phase: .connecting).statusSentence(accountKnown: true) == "Connecting…")
        #expect(HostedCloud(phase: .ready).actionTitle(accountKnown: true) == nil)
        #expect(HostedCloud(phase: .ready).statusSentence(accountKnown: true) == "Connected")
        #expect(HostedCloud(phase: .error, error: "Nope.").actionTitle(accountKnown: true) == "Reconnect")
    }

    @Test func legacySentencePerKindAndMoving() {
        #expect(HostedCloud(legacy: .firebase).legacySentence() == "This Mac still uses your own Firebase. Sign in to move it; paired devices follow.")
        #expect(HostedCloud(legacy: .shared).legacySentence() == "This Mac still uses Squeak's old shared server. Sign in to move it; paired devices follow.")
        #expect(HostedCloud(legacy: .catalystOwn).legacySentence() == "This Mac still uses your own Catalyst relay. Sign in to move it; paired devices follow.")
        #expect(HostedCloud(legacy: .firebase, moving: true).legacySentence() == nil)
        #expect(HostedCloud(phase: .ready).legacySentence() == nil)
    }

    @Test func cloudStateIsNilOn404() async throws {
        #expect(try await client(CloudStub(status: 404, body: "")).cloudState() == nil)
    }

    @Test func connectPostsAndMapsAnswers() async {
        let ok = CloudStub(status: 202, body: "{}")
        #expect(await client(ok).connectHosted().ok)
        #expect(ok.requests.first?.url.path == "/control/cloud/hosted/connect")
        #expect(ok.requests.first?.method == "POST")
        #expect(await client(CloudStub(status: 409, body: #"{"error":"not-signed-in"}"#)).connectHosted().error == "Sign in to Squeak first.")
        #expect(await client(CloudStub(status: 410, body: "")).connectHosted() == .olderDaemon)
    }
}
