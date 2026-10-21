import Foundation
import Testing
@testable import SqueakMacCore

private func tempEnvURL(_ content: String? = nil) -> URL {
    let dir = FileManager.default.temporaryDirectory.appending(path: "squeak-env-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appending(path: ".env")
    if let content { try? content.write(to: url, atomically: true, encoding: .utf8) }
    return url
}

private func perms(_ url: URL) -> Int {
    ((try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions]) as? Int) ?? -1
}

@Suite("EnvFile")
struct EnvFileTests {
    static let sample = """
    # Squeak settings
    SQUEAK_BOT_TOKEN=111:old-token

    # who may talk to the bot
    SQUEAK_ALLOWED_CHAT_IDS=1,2
    SOMETHING_ELSE="keep me"   # inline note
    export EXPORTED=yes
    #SQUEAK_CLIQ_OWNER_ID=commented
    """ + "\n"

    @Test func roundTripPreservesCommentsOrderAndUnknownKeys() throws {
        let url = tempEnvURL(Self.sample)
        let env = EnvFile(url: url)
        try env.set("SQUEAK_BOT_TOKEN", "222:new-token")
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text == Self.sample.replacingOccurrences(of: "111:old-token", with: "222:new-token"))
        #expect(env.value("SOMETHING_ELSE") == "keep me")
        #expect(env.value("EXPORTED") == "yes")
        #expect(env.value("SQUEAK_CLIQ_OWNER_ID") == nil) // a comment is not a value
        #expect(perms(url) == 0o600)
    }

    @Test func addsNewKeysAtTheEndAndRemovesOnlyThatKey() throws {
        let url = tempEnvURL(Self.sample)
        let env = EnvFile(url: url)
        try env.set("SQUEAK_CLIQ_OWNER_EMAIL", "me@example.com")
        #expect(try String(contentsOf: url, encoding: .utf8).hasSuffix("SQUEAK_CLIQ_OWNER_EMAIL=me@example.com\n"))
        try env.remove("SQUEAK_BOT_TOKEN")
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(!text.contains("SQUEAK_BOT_TOKEN"))
        #expect(text.contains("# Squeak settings"))
        #expect(text.contains("\n\n# who may talk"))
        #expect(env.has("SQUEAK_ALLOWED_CHAT_IDS") && !env.has("SQUEAK_BOT_TOKEN"))
    }

    @Test func quotesOnlyWhenNeeded() throws {
        let url = tempEnvURL()
        let env = EnvFile(url: url)
        try env.apply([
            "TOKEN": "123456:ABC-def_ghi", "URL": "https://cliq.zoho.in/api/v2/bots/squeak/incoming?zapikey=a=b",
            "SPACED": "two words", "HASH": "a # b", "QUOTE": #"say "hi" \ now"#, "EMPTY": "",
        ])
        let text = try String(contentsOf: url, encoding: .utf8)
        #expect(text.contains("TOKEN=123456:ABC-def_ghi\n"))
        #expect(text.contains("URL=\"https://cliq.zoho.in/api/v2/bots/squeak/incoming?zapikey=a=b\"\n")) // '?' is quoted
        #expect(text.contains("SPACED=\"two words\"\n"))
        for (k, v) in ["SPACED": "two words", "HASH": "a # b", "QUOTE": #"say "hi" \ now"#, "EMPTY": "",
                       "URL": "https://cliq.zoho.in/api/v2/bots/squeak/incoming?zapikey=a=b"] {
            #expect(env.value(k) == v)
        }
    }

    @Test func createsMissingFileWithOwnerOnlyMode() throws {
        let url = tempEnvURL()
        try EnvFile(url: url).set("A", "1")
        #expect(perms(url) == 0o600)
        #expect(try String(contentsOf: url, encoding: .utf8) == "A=1\n")
    }

    @Test func tightensALooseMode() throws {
        let url = tempEnvURL("A=1\n")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: url.path)
        try EnvFile(url: url).set("B", "2")
        #expect(perms(url) == 0o600)
    }

    @Test func noTempFilesLeftBehind() throws {
        let url = tempEnvURL("A=1\n")
        try EnvFile(url: url).set("B", "2")
        let names = try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)
        #expect(names == [".env"])
    }

    @Test func duplicateKeysCollapseToOne() throws {
        let url = tempEnvURL("A=1\nB=2\nA=3\n")
        try EnvFile(url: url).set("A", "9")
        #expect(try String(contentsOf: url, encoding: .utf8) == "A=9\nB=2\n")
    }
}

@Suite("Channel routes")
struct ChannelRouteTests {
    private func client(_ t: FakeTransport, token: String? = "tok") -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { token })
    }

    @Test func decodesChannelsAndSendsTheToken() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/channels", """
        {"telegram":{"configured":true,"polling":"ok","lastError":null,"botUsername":"squeak_bot","allowedChatIds":[42,-100],"open":false,"future":1},
         "cliq":{"oneWay":true,"twoWay":false},"phone":{"enabled":true},"extra":{}}
        """)
        let c = try #require(try await client(t).channels())
        #expect(c.telegram.polling == .ok && c.telegram.botUsername == "squeak_bot" && c.telegram.allowedChatIds == [42, -100])
        #expect(c.cliq.oneWay && !c.cliq.twoWay && c.phone.enabled)
        #expect(await t.requests.first?.headers["x-squeak-token"] == "tok")
    }

    @Test func missingFieldsReadAsOff() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/channels", #"{"telegram":{"polling":"weird"}}"#)
        let c = try #require(try await client(t).channels())
        #expect(c.telegram == .init() && c.cliq == .init() && !c.phone.enabled)
    }

    @Test func olderDaemonAnswers404AsNil() async throws {
        let t = FakeTransport() // unrouted paths are 404
        let c = client(t)
        #expect(try await c.channels() == nil)
        #expect(try await c.telegramCandidates() == nil)
        #expect(try await c.telegramTest() == nil)
    }

    @Test func rejectedTokenThrows() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/channels", status: 403, "forbidden")
        await #expect(throws: AdapterError.tokenRejected) { _ = try await client(t).channels() }
        await #expect(throws: AdapterError.tokenMissing) { _ = try await client(t, token: nil).channels() }
    }

    @Test func decodesCandidatesSkippingBadRows() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/telegram/candidates", """
        {"chats":[{"id":7,"name":"Sibhi","type":"private","at":"2026-10-19T08:00:00Z"},{"name":"no id"},{"id":-5,"name":"Team","type":"group"}]}
        """)
        let chats = try #require(try await client(t).telegramCandidates())
        #expect(chats.map(\.id) == [7, -5])
        #expect(chats[0].at != nil && chats[1].at == nil)
    }

    @Test func telegramTestReadsRefusals() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/telegram/test", status: 409, #"{"ok":false,"sentTo":0,"reason":"No chat is linked yet"}"#)
        let r = try #require(try await client(t).telegramTest())
        #expect(!r.ok && r.reason == "No chat is linked yet")
        await t.json("POST", "/control/telegram/test", #"{"ok":true,"sentTo":2}"#)
        #expect(try await client(t).telegramTest() == TelegramTestResult(ok: true, sentTo: 2))
    }

    @Test func decodesRemoteStatus() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/remote/status", """
        {"available":true,"configured":true,"projectId":"p","phoneOpen":true,"pairingOpen":true,
         "devices":[{"id":"d1","name":"Sibhi's iPhone","pairedAt":"2026-10-01T09:00:00.000Z","revokedAt":null},
                    {"id":"d2","name":"Old","pairedAt":"2026-09-01T09:00:00.000Z","revokedAt":"2026-09-02T09:00:00.000Z"}],
         "pending":[{"id":"d3","name":"New phone","code":"4821","requestedAt":"2026-10-19T08:00:00.000Z"}],"activity":[]}
        """)
        let s = try #require(try await client(t).remoteStatus())
        #expect(s.available && s.configured && s.pairingOpen)
        #expect(s.activeDevices.map(\.id) == ["d1"])
        #expect(s.pending.first?.code == "4821")
    }

    @Test func remoteUnavailableAndOlderDaemon() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/remote/status", #"{"configured":false,"available":false}"#)
        #expect(try await client(t).remoteStatus()?.available == false)
        await t.json("GET", "/control/remote/status", status: 503, "remote unavailable")
        #expect(try await client(t).remoteStatus() == nil)
        await t.json("GET", "/control/remote/status", status: 404, "not found")
        #expect(try await client(t).remoteStatus() == nil)
    }

    @Test func pairingCodeKeepsTheExactQRTextAndNamesTheWebApp() async throws {
        let code = "squeak://pair?d=eyJhIjoxLCJiIjoiPT0rLy8ifQ%3D%3D&x=1"
        let t = FakeTransport()
        await t.json("POST", "/control/remote/pair", #"{"url":"\#(code)"}"#)
        #expect(try await client(t).remotePair()?.url == code)
        #expect(RemotePairing.webAppAddress == "squeak-5c9gvo.web.app/app")
    }

    @Test func pairingAndActionsUseTheDaemonsPaths() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/remote/pair", #"{"url":"squeak://pair?d=abc"}"#)
        await t.json("POST", "/control/remote/approve/d3", #"{"ok":true}"#)
        await t.json("POST", "/control/remote/reject/d3", #"{"ok":false}"#)
        await t.json("POST", "/control/remote/revoke/d1", #"{"ok":true}"#)
        let c = client(t)
        #expect(try await c.remotePair()?.url == "squeak://pair?d=abc")
        #expect(try await c.remoteApprove(deviceId: "d3"))
        #expect(try await c.remoteReject(deviceId: "d3") == false)
        #expect(try await c.remoteRevoke(deviceId: "d1"))
        #expect(await t.requests.allSatisfy { $0.method == "POST" && $0.headers["x-squeak-token"] == "tok" })
    }
}

@Suite("DaemonService")
struct DaemonServiceTests {
    actor Recorder { var calls: [(String, [String])] = []; func add(_ e: String, _ a: [String]) { calls.append((e, a)) } }

    @Test func kickstartsTheLaunchAgent() async throws {
        let rec = Recorder()
        let svc = DaemonService(uid: 501) { exe, args in await rec.add(exe, args); return 0 }
        try await svc.restart()
        let call = try #require(await rec.calls.first)
        #expect(call.0 == "/bin/launchctl")
        #expect(call.1 == ["kickstart", "-k", "gui/501/com.squeak.daemon"])
    }

    @Test func nonZeroExitThrows() async {
        let svc = DaemonService(uid: 501) { _, _ in 113 }
        await #expect(throws: DaemonService.RestartError.failed(113)) { try await svc.restart() }
    }
}
