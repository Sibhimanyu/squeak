import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Conductor relay status")
struct RelayStatusTests {
    private func client(_ t: RelayStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }

    private func body(_ state: String, extra: String = "") -> String {
        #"{"state":"\#(state)","conductorInstalled":true,"conductorVersion":"0.91.2","versionTested":true,"configured":true,"paired":true,"hostConnected":false,"lastHostAt":"2026-10-28T10:00:00Z","port":8478,"message":"m","steps":["a","b"]\#(extra)}"#
    }

    @Test(arguments: [
        ("unsupported", RelayState.unsupported), ("not-installed", .notInstalled), ("off", .off),
        ("needs-restart", .needsRestart), ("waiting", .waiting), ("connected", .connected), ("error", .error),
    ])
    func decodesEveryState(raw: String, state: RelayState) async throws {
        let s = try await client(RelayStub(200, body(raw))).relayStatus()
        #expect(s?.state == state)
        #expect(s?.steps == ["a", "b"] && s?.port == 8478 && s?.message == "m" && s?.conductorVersion == "0.91.2")
    }

    @Test func unknownStateAndMissingFieldsAreLenient() async throws {
        let s = try await client(RelayStub(200, #"{"state":"quantum"}"#)).relayStatus()
        #expect(s?.state == .unknown && s?.steps == [] && s?.message == "")
    }

    @Test func olderDaemonIsNil() async throws {
        #expect(try await client(RelayStub(404, "")).relayStatus() == nil)
        #expect(try await client(RelayStub(503, "")).relayStatus() == nil)
    }

    @Test func setupPostsOnceWithForceOnlyWhenAsked() async {
        let t = RelayStub(200, #"{"ok":true,"status":"# + body("needs-restart") + "}")
        let r = await client(t).setupRelay()
        #expect(r.ok && r.status?.state == .needsRestart)
        #expect(t.requests.count == 1 && t.requests[0].method == "POST" && t.requests[0].url.path == "/control/relay/setup")
        #expect(String(decoding: t.requests[0].body ?? Data(), as: UTF8.self) == "{}")
        _ = await client(t).setupRelay(force: true)
        #expect(String(decoding: t.requests[1].body ?? Data(), as: UTF8.self).contains(#""force":true"#))
    }

    @Test func failureCarriesTheReasonAndIsNotRetried() async {
        let t = RelayStub(409, #"{"ok":false,"reason":"Quit Conductor first."}"#)
        let r = await client(t).resetRelay()
        #expect(!r.ok && r.reason == "Quit Conductor first.")
        #expect(t.requests.count == 1 && t.requests[0].url.path == "/control/relay/reset")
    }

    @Test func olderDaemonSaysUpdateTheService() async {
        #expect(await client(RelayStub(404, "")).setupRelay() == .updateService)
        #expect(await client(RelayStub(503, "")).resetRelay().reason == "Update the background service")
    }

    @Test func recognisesTheRelayProblemSentence() {
        #expect(RelayStatus.isRelayProblem("Conductor's relay isn't connected, so this can't be answered from here."))
        #expect(!RelayStatus.isRelayProblem("Squeak isn't running."))
        #expect(!RelayStatus.isRelayProblem(nil))
    }
}

private final class RelayStub: HTTPTransport, @unchecked Sendable {
    let status: Int, text: String
    private(set) var requests: [HTTPRequest] = []
    init(_ status: Int, _ text: String) { self.status = status; self.text = text }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(text.utf8))
    }
}
