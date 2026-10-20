import Foundation
import Testing
@testable import SqueakMacCore

private let workspacesJSON = """
{"workspaces":[
 {"id":"w-old","repoName":"squeak","branch":"oslo","lastActivityAt":"2026-10-01T04:30:00.000Z","defaultAgent":"codex"},
 {"id":"w-new","repoName":"squeak","branch":"blume","title":"Fix the thing","lastActivityAt":"2026-10-19T04:30:00.000Z","defaultAgent":"claude"},
 {"repoName":"no id"},
 {"id":"w-odd","repoName":7,"branch":null,"defaultAgent":"gemini"}
]}
"""

private func client(_ t: FakeTransport, token: String? = "tok") -> DaemonClient {
    DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { token })
}

@Suite("New chat")
struct NewChatTests {
    @Test func decodesWorkspacesLeniently() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/workspaces", workspacesJSON)
        let list = try #require(try await client(t).newChatWorkspaces())
        #expect(list.map(\.id) == ["w-old", "w-new", "w-odd"]) // the id-less row is dropped
        #expect(list[1].label == "squeak · blume" && list[1].title == "Fix the thing")
        #expect(list[0].lastActivityAt != nil && list[0].defaultAgent == .codex)
        #expect(list[2].repoName == "" && list[2].defaultAgent == .claude) // wrong types and unknown agent fall back
        let req = await t.requests.first
        #expect(req?.headers["x-squeak-token"] == "tok")
    }

    @Test func workspacesNilWhenDaemonIsOld() async throws {
        let t = FakeTransport()
        #expect(try await client(t).newChatWorkspaces() == nil) // 404
        await t.json("GET", "/control/workspaces", status: 503, "")
        #expect(try await client(t).newChatWorkspaces() == nil)
    }

    @Test func startChatSendsExactBodyAndReadsSessionId() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/chats", #"{"ok":true,"sessionId":"abc-1"}"#)
        let r = await client(t).startChat(workspaceId: "w1", agent: .codex, text: "do it")
        #expect(r == .started(sessionId: "abc-1"))
        let req = try #require(await t.requests.first)
        #expect(req.headers["x-squeak-token"] == "tok")
        let body = try #require(try JSONSerialization.jsonObject(with: req.body ?? Data()) as? [String: String])
        #expect(body == ["workspaceId": "w1", "agent": "codex", "text": "do it"])
    }

    @Test func startChatMapsFailuresHonestly() async {
        let t = FakeTransport()
        await t.json("POST", "/control/chats", #"{"ok":false,"reason":"Conductor's relay isn't connected"}"#)
        #expect(await client(t).startChat(workspaceId: "w", agent: .claude, text: "x") == .failed(reason: "Conductor's relay isn't connected"))

        await t.json("POST", "/control/chats", status: 403, "forbidden")
        #expect(await client(t).startChat(workspaceId: "w", agent: .claude, text: "x") == .failed(reason: "Squeak rejected the access token"))

        await t.route("POST", "/control/chats", .failure(.connectionRefused))
        #expect(await client(t).startChat(workspaceId: "w", agent: .claude, text: "x") == .failed(reason: "Squeak is not running"))

        // A timeout may have created the chat: it is never presented as a clean failure.
        await t.route("POST", "/control/chats", .failure(.timedOut))
        if case .uncertain = await client(t).startChat(workspaceId: "w", agent: .claude, text: "x") {} else { Issue.record("expected uncertain") }

        #expect(await client(t, token: nil).startChat(workspaceId: "w", agent: .claude, text: "x") == .failed(reason: "Squeak's access token was not found"))

        let old = FakeTransport() // 404: an older daemon
        if case .failed(let reason) = await client(old).startChat(workspaceId: "w", agent: .claude, text: "x") { #expect(reason.contains("Update")) } else { Issue.record("expected failed") }
    }

    // MARK: Form

    private let a = NewChatWorkspace(id: "a", repoName: "orchard", branch: "fix/retry", title: "Checkout retries", lastActivityAt: Date(timeIntervalSince1970: 300), defaultAgent: .claude)
    private let b = NewChatWorkspace(id: "b", repoName: "lighthouse", branch: "main", lastActivityAt: Date(timeIntervalSince1970: 900), defaultAgent: .codex)
    private let c = NewChatWorkspace(id: "c", repoName: "orchard", branch: "docs", lastActivityAt: nil, defaultAgent: .claude)

    @Test func formSortsRecentFirstAndSelectsNewest() {
        let f = NewChatForm(workspaces: [a, c, b])
        #expect(f.workspaces.map(\.id) == ["b", "a", "c"])
        #expect(f.workspaceId == "b" && f.agent == .codex)
    }

    @Test func agentFollowsWorkspaceUntilChosen() {
        var f = NewChatForm(workspaces: [a, b])
        f.select("a")
        #expect(f.agent == .claude)
        f.choose(agent: .codex)
        f.select("a")
        #expect(f.agent == .codex) // the user's pick wins
    }

    @Test func searchMatchesEveryWordAcrossRepoBranchAndTitle() {
        var f = NewChatForm(workspaces: [a, b, c])
        f.query = "orchard"
        #expect(f.filtered.map(\.id) == ["a", "c"])
        f.query = "orch retries"
        #expect(f.filtered.map(\.id) == ["a"])
        f.query = "nothing"
        #expect(f.filtered.isEmpty)
    }

    @Test func canStartNeedsWorkspaceTextAndLength() {
        var f = NewChatForm()
        f.text = "hi"
        #expect(!f.canStart) // no workspace
        f = NewChatForm(workspaces: [a])
        #expect(!f.canStart)
        f.text = "  \n "
        #expect(!f.canStart)
        f.text = " go "
        #expect(f.canStart && f.trimmedText == "go")
        f.text = String(repeating: "x", count: NewChatForm.maxLength + 1)
        #expect(f.isTooLong && !f.canStart)
    }

    @Test func refreshingTheListKeepsTheDraft() {
        var f = NewChatForm(workspaces: [a, b], preselect: "a")
        f.text = "half written"
        f.query = "orch"
        f.choose(agent: .codex)
        f.setWorkspaces([b, a, c])
        #expect(f.workspaceId == "a" && f.text == "half written" && f.query == "orch" && f.agent == .codex)
        f.setWorkspaces([b]) // the selected workspace vanished
        #expect(f.workspaceId == "b")
    }
}
