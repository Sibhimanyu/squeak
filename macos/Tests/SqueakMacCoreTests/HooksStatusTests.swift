import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Agent hooks status")
struct HooksStatusTests {
    private func client(_ t: HooksStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }

    private let full = #"{"state":"partial","claude":{"settingsFound":true,"hooksInstalled":false,"missing":["Stop","PermissionRequest"],"askFormat":true},"codex":{"agentsFound":true,"askFormat":false},"message":"Some hooks are missing.","steps":["one","two"]}"#

    @Test func decodesEveryField() async throws {
        let s = try #require(try await client(HooksStub(200, full)).hooksStatus())
        #expect(s.state == .partial && s.message == "Some hooks are missing." && s.steps == ["one", "two"])
        #expect(s.claude == .init(settingsFound: true, hooksInstalled: false, missing: ["Stop", "PermissionRequest"], askFormat: true))
        #expect(s.codex == .init(agentsFound: true, askFormat: false))
    }

    @Test(arguments: [("installed", HooksState.installed), ("partial", .partial), ("missing", .missing), ("error", .error)])
    func decodesEveryState(raw: String, state: HooksState) async throws {
        #expect(try await client(HooksStub(200, #"{"state":"\#(raw)"}"#)).hooksStatus()?.state == state)
    }

    @Test func unknownStateAndMissingFieldsAreLenient() async throws {
        let s = try #require(try await client(HooksStub(200, #"{"state":"quantum","claude":"nope"}"#)).hooksStatus())
        #expect(s.state == .unknown && s.claude == .init() && s.codex == .init() && s.steps == [] && s.message == "")
    }

    @Test func olderDaemonIsNil() async throws {
        #expect(try await client(HooksStub(404, "")).hooksStatus() == nil)
        #expect(try await client(HooksStub(503, "")).hooksStatus() == nil)
    }

    @Test func installPostsOnceAndReturnsTheStatus() async {
        let t = HooksStub(200, #"{"ok":true,"status":"# + full + "}")
        let r = await client(t).installHooks()
        #expect(r.ok && r.status?.state == .partial)
        #expect(t.requests.count == 1 && t.requests[0].method == "POST" && t.requests[0].url.path == "/control/hooks/install")
        #expect(String(decoding: t.requests[0].body ?? Data(), as: UTF8.self) == "{}")
        #expect(t.requests[0].headers["x-squeak-token"] == "tok")
    }

    @Test func uninstallUsesItsOwnRoute() async {
        let t = HooksStub(200, #"{"ok":true}"#)
        _ = await client(t).uninstallHooks()
        #expect(t.requests.count == 1 && t.requests[0].url.path == "/control/hooks/uninstall")
    }

    @Test func failureCarriesTheReasonAndIsNotRetried() async {
        let t = HooksStub(409, #"{"ok":false,"reason":"settings.json is not valid JSON."}"#)
        let r = await client(t).installHooks()
        #expect(!r.ok && r.reason == "settings.json is not valid JSON.")
        #expect(t.requests.count == 1)
    }

    @Test func olderDaemonSaysUpdateTheService() async {
        #expect(await client(HooksStub(404, "")).installHooks() == .updateService)
        #expect(await client(HooksStub(503, "")).uninstallHooks().reason == "Update the background service")
    }
}

private final class HooksStub: HTTPTransport, @unchecked Sendable {
    let status: Int, text: String
    private(set) var requests: [HTTPRequest] = []
    init(_ status: Int, _ text: String) { self.status = status; self.text = text }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        return HTTPResponse(status: status, body: Data(text.utf8))
    }
}
