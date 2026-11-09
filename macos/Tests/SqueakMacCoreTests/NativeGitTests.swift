import Foundation
import Testing
@testable import SqueakMacCore

private func pr(
    _ state: NativePullRequest.State = .open, draft: Bool = false, mergeable: Bool? = true, checks: NativePullRequest.Checks = .passing
) -> NativePullRequest {
    NativePullRequest(number: 7, url: "https://github.com/o/r/pull/7", state: state, draft: draft, mergeable: mergeable, checks: checks)
}

private func status(_ pr: NativePullRequest? = nil, dirty: Int = 0, ahead: Int? = 1, behind: Int? = 0, reason: String? = "none") -> NativeGitStatus {
    NativeGitStatus(branch: "me/duck", base: "master", ahead: ahead, behind: behind, dirty: dirty, pr: pr, prReason: reason)
}

struct GitPrimaryTests {
    @Test func noPullRequestOffersCreateOnlyWithSomethingToPutInOne() {
        #expect(GitPresentation.primary(status()) == .action(.createPR))
        #expect(GitPresentation.primary(status(dirty: 2, ahead: 0)) == .action(.createPR))
        #expect(GitPresentation.primary(status(ahead: 0)) == nil)
        // gh missing or GitHub unreachable: nothing to press, the note says why.
        #expect(GitPresentation.primary(status(reason: "gh-missing")) == nil)
        #expect(GitPresentation.primary(status(reason: "unavailable")) == nil)
    }

    @Test func anOpenPullRequestFollowsConflictsThenChecksThenWorkThenMerge() {
        #expect(GitPresentation.primary(status(pr(mergeable: false, checks: .failing))) == .action(.resolveConflicts))
        #expect(GitPresentation.primary(status(pr(checks: .failing))) == .action(.fixErrors))
        #expect(GitPresentation.primary(status(pr(), dirty: 1)) == .action(.commitPush))
        #expect(GitPresentation.primary(status(pr())) == .action(.merge))
        #expect(GitPresentation.primary(status(pr(checks: .none))) == .action(.merge))
    }

    @Test func nothingToPressWhileGitHubOrTheChecksAreStillWorking() {
        #expect(GitPresentation.primary(status(pr(checks: .running))) == nil)
        #expect(GitPresentation.primary(status(pr(mergeable: nil))) == nil)
        #expect(GitPresentation.primary(status(pr(draft: true))) == nil)
    }

    @Test func mergedAndClosedAreQuietWords() {
        #expect(GitPresentation.primary(status(pr(.merged))) == .merged)
        #expect(GitPresentation.primary(status(pr(.closed))) == .closed)
    }

    @Test func menuEnablementMatchesTheState() {
        let clean = status(pr())
        #expect(GitPresentation.isEnabled(.merge, clean))
        #expect(!GitPresentation.isEnabled(.fixErrors, clean) && !GitPresentation.isEnabled(.resolveConflicts, clean))
        #expect(!GitPresentation.isEnabled(.createPR, clean))
        #expect(GitPresentation.isEnabled(.fixErrors, status(pr(checks: .failing))))
        #expect(!GitPresentation.isEnabled(.merge, status(pr(checks: .failing))))
        // Pull latest only when the base moved ahead; a changelog needs work to describe.
        #expect(!GitPresentation.isEnabled(.pullLatest, status()))
        #expect(GitPresentation.isEnabled(.pullLatest, status(behind: 3)))
        #expect(GitPresentation.isEnabled(.changelog, status()))
        #expect(!GitPresentation.isEnabled(.changelog, status(ahead: 0)))
        #expect(GitPresentation.isEnabled(.resolveConflicts, status(pr(mergeable: false))))
        #expect(!GitPresentation.isEnabled(.merge, status(pr(draft: true))))
        #expect(!GitPresentation.isEnabled(.merge, status(pr(.merged))))
        #expect(GitPresentation.isEnabled(.createPR, status()))
        #expect(GitPresentation.isEnabled(.createPR, status(pr(.closed))))
        #expect(!GitPresentation.isEnabled(.commitPush, status(ahead: 0)))
        #expect(GitPresentation.isEnabled(.commitPush, status(dirty: 3)))
    }

    @Test func shortcutsAreConductorsAndDoNotCollide() {
        let keys = GitActionKind.allCases.compactMap(\.shortcutKey)
        #expect(Set(keys).count == keys.count)
        #expect(GitActionKind.createPR.shortcutKey == "p" && GitActionKind.commitPush.shortcutKey == "y")
        #expect(GitActionKind.merge.shortcutKey == "m" && GitActionKind.fixErrors.shortcutKey == "x" && GitActionKind.review.shortcutKey == "r")
        #expect(GitActionKind.resolveConflicts.shortcutKey == nil)
        // The app already binds ⌘⇧D (composer) and ⌘⇧O (open in Conductor).
        #expect(!keys.contains("d") && !keys.contains("o"))
    }
}

struct GitWordsTests {
    @Test func theOnlyStateWordsArethePullRequestsOwn() {
        #expect(GitPresentation.prLine(pr()) == "#7 · Open")
        #expect(GitPresentation.prWord(pr(draft: true)) == "Draft")
        #expect(GitPresentation.prWord(pr(.merged)) == "Merged" && GitPresentation.prWord(pr(.closed)) == "Closed")
    }

    @Test func checksAreMarks() {
        #expect(GitPresentation.checksMark(pr(checks: .passing)) == .passing)
        #expect(GitPresentation.checksMark(pr(checks: .failing)) == .failing)
        #expect(GitPresentation.checksMark(pr(checks: .running)) == .running)
        #expect(GitPresentation.checksMark(pr(checks: .none)) == nil)
    }

    @Test func mergeableLineIsASentenceOnlyForOpenPullRequests() {
        #expect(GitPresentation.mergeableLine(status(pr())) == "No conflicts with master.")
        #expect(GitPresentation.mergeableLine(status(pr(mergeable: false)))?.hasPrefix("Conflicts with master") == true)
        #expect(GitPresentation.mergeableLine(status(pr(mergeable: nil)))?.contains("still checking") == true)
        #expect(GitPresentation.mergeableLine(status(pr(.merged))) == nil)
        #expect(GitPresentation.mergeableLine(status()) == nil)
    }

    @Test func aheadBehindLeavesOutZerosAndUnknowns() {
        #expect(GitPresentation.aheadBehind(status(ahead: 2, behind: 1)) == "↑2 ↓1")
        #expect(GitPresentation.aheadBehind(status(ahead: 0, behind: 3)) == "↓3")
        #expect(GitPresentation.aheadBehind(status(ahead: nil, behind: nil)) == nil)
        #expect(GitPresentation.aheadBehindWords(status(ahead: 2, behind: 1)) == "2 ahead of master, 1 behind master")
    }

    @Test func mergeSentenceNamesThePullRequestAndTheMethod() {
        #expect(GitPresentation.mergeSentence(pr(), base: "master", method: "squash") == "Squash and merge pull request #7 into master.")
        #expect(GitPresentation.mergeSentence(pr(), base: "main", method: "rebase").hasPrefix("Rebase and merge"))
        #expect(GitPresentation.methodTitle("merge") == "Create a merge commit")
    }

    @Test func onlyHttpsPullRequestLinksOpen() {
        #expect(GitPresentation.prURL(status(pr())) != nil)
        #expect(GitPresentation.prURL(status(NativePullRequest(number: 1, url: "file:///etc/passwd"))) == nil)
        #expect(GitPresentation.prURL(status()) == nil)
    }

    @Test func refreshPolicyMirrorsChanges() {
        let now = Date()
        #expect(GitPresentation.refreshInterval == 10)
        #expect(!GitPresentation.shouldRefresh(visible: false, activityChanged: true, lastRead: nil, now: now))
        #expect(GitPresentation.shouldRefresh(visible: true, activityChanged: true, lastRead: now, now: now))
        #expect(!GitPresentation.shouldRefresh(visible: true, activityChanged: false, lastRead: now.addingTimeInterval(-9), now: now))
        #expect(GitPresentation.shouldRefresh(visible: true, activityChanged: false, lastRead: now.addingTimeInterval(-10), now: now))
    }
}

struct WorkspaceLifecycleTests {
    @Test func statesMapToMarks() {
        #expect(WorkspaceLifecycle.mark("setting_up") == .settingUp && WorkspaceLifecycle.mark("setup_failed") == .setupFailed)
        #expect(WorkspaceLifecycle.mark("ready") == nil && WorkspaceLifecycle.mark("archived") == nil)
        #expect(WorkspaceLifecycle.words(.setupFailed) == "Setup failed")
    }

    @Test func pollsBrisklyOnlyWhileSomethingSetsUp() {
        let ready = NativeWorkspace(id: "a", projectId: "p", name: "a", path: "/a", branch: "b")
        let setting = NativeWorkspace(id: "b", projectId: "p", name: "b", path: "/b", branch: "b", state: "setting_up")
        #expect(WorkspaceLifecycle.pollInterval([ready]) == 20)
        #expect(WorkspaceLifecycle.pollInterval([ready, setting]) == 2)
    }

    @Test func localhostNeedsAPort() {
        #expect(WorkspaceLifecycle.localhostURL(port: 3010)?.absoluteString == "http://localhost:3010")
        #expect(WorkspaceLifecycle.openTitle(port: 3010) == "Open localhost:3010")
        #expect(WorkspaceLifecycle.localhostURL(port: nil) == nil)
    }

    @Test func onlyAnUncommittedRefusalCanBeForced() {
        #expect(WorkspaceLifecycle.refusal(NativeHostError.http(409, "The workspace has uncommitted changes.")) == .uncommitted)
        #expect(WorkspaceLifecycle.refusal(NativeHostError.http(409, "A chat in this workspace is still working or waiting. Stop it first."))
            == .other("A chat in this workspace is still working or waiting. Stop it first."))
        #expect(WorkspaceLifecycle.refusal(NativeHostError.hostDown) == .other("Squeak's session host isn't running"))
    }
}

struct ProjectSettingsDraftTests {
    private static let json = #"""
    {"settings":{"setupScript":"npm i","runScript":null,"archiveScript":null,"branchPrefix":null,"mergeMethod":null,"prompts":{"review":"Look hard."}},
     "effective":{"setupScript":"npm i","runScript":"npm run dev","archiveScript":null,"branchPrefix":"me/","mergeMethod":"squash","prompts":{}},
     "sources":{"setupScript":"project","runScript":"conductor.json","archiveScript":"default","branchPrefix":"default","mergeMethod":"default","prompts":{"review":"project"}},
     "defaultPrompts":{"create-pr":"Open a PR against {base}.","review":"Review it."}}
    """#

    @Test func decodesWhatTheHostReports() throws {
        let s = try JSONDecoder().decode(NativeProjectSettings.self, from: Data(Self.json.utf8))
        #expect(s.settings.setupScript == "npm i" && s.settings.runScript == nil)
        #expect(s.effective.runScript == "npm run dev" && s.sources.runScript == "conductor.json")
        #expect(s.sources.prompts["review"] == "project" && s.defaultPrompts["create-pr"] == "Open a PR against {base}.")
    }

    @Test func reviewModelGoesWithItsEffortAndClearsTogether() throws {
        let s = try JSONDecoder().decode(NativeProjectSettings.self, from: Data(Self.json.utf8))
        #expect(s.settings.reviewModel == nil)
        var d = ProjectSettingsDraft(s)
        d.reviewModel = "opus-5"
        d.reviewEffort = "high"
        let p = d.patch(from: s)
        #expect(p["reviewModel"] == .string("opus-5") && p["reviewEffort"] == .string("high"))

        let set = try JSONDecoder().decode(NativeProjectSettings.self, from: Data(#"{"settings":{"reviewModel":"gpt-5.6-terra","reviewEffort":"low"},"effective":{"reviewModel":"gpt-5.6-terra","reviewEffort":"low"}}"#.utf8))
        #expect(set.effective.reviewModel == "gpt-5.6-terra" && set.settings.reviewEffort == "low")
        var cleared = ProjectSettingsDraft(set)
        cleared.reviewModel = ""
        cleared.reviewEffort = ""
        let q = cleared.patch(from: set)
        #expect(q["reviewModel"] == .null && q["reviewEffort"] == .null)
    }

    @Test func anUnchangedDraftSendsNothing() throws {
        let s = try JSONDecoder().decode(NativeProjectSettings.self, from: Data(Self.json.utf8))
        #expect(ProjectSettingsDraft(s).patch(from: s).isEmpty)
    }

    @Test func onlyChangesGoAndEmptyFieldsClear() throws {
        let s = try JSONDecoder().decode(NativeProjectSettings.self, from: Data(Self.json.utf8))
        var d = ProjectSettingsDraft(s)
        d.setupScript = "  "
        d.runScript = "pnpm dev"
        d.mergeMethod = "rebase"
        d.branchPrefix = "feat"
        d.prompts["create-pr"] = "Open a draft PR."
        d.prompts["review"] = "Review it."   // equals the default: clears the override
        let p = d.patch(from: s)
        #expect(p["setupScript"] == .null && p["runScript"] == .string("pnpm dev"))
        #expect(p["mergeMethod"] == .string("rebase") && p["branchPrefix"] == .string("feat"))
        #expect(p["archiveScript"] == nil)
        #expect(p["prompts"] == .object(["create-pr": .string("Open a draft PR."), "review": .null]))
    }
}

private final class Stub: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [HTTPRequest] = []
    let handler: @Sendable (HTTPRequest) -> HTTPResponse
    init(_ handler: @escaping @Sendable (HTTPRequest) -> HTTPResponse) { self.handler = handler }
    var requests: [HTTPRequest] { lock.withLock { log } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { log.append(request) }
        return handler(request)
    }
}

struct NativeGitClientTests {
    private func client(_ stub: Stub) -> NativeHostClient {
        NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: stub, tokenProvider: { "tok" })
    }

    @Test func routesAndBodiesMatchTheHost() async throws {
        let stub = Stub { r in
            let ok = { (j: String) in HTTPResponse(status: 200, body: Data(j.utf8)) }
            switch (r.method, r.url.path) {
            case ("GET", "/native/sessions/s1/git"):
                return ok(#"{"branch":"me/duck","base":"master","baseRef":"origin/master","ahead":2,"behind":0,"dirty":1,"pr":{"number":9,"url":"https://github.com/o/r/pull/9","state":"open","draft":false,"mergeable":null,"checks":"running"}}"#)
            case ("POST", "/native/sessions/s1/actions/create-pr"): return ok(#"{"ok":true,"queued":true,"prompt":"Open it."}"#)
            case ("POST", "/native/sessions/s1/actions/merge"): return ok(#"{"ok":true,"method":"rebase","pr":{"number":9}}"#)
            case ("GET", "/native/workspaces/w1/log"): return ok(#"{"state":"setup_failed","log":"boom"}"#)
            case ("GET", "/native/workspaces/w1/run"), ("POST", "/native/workspaces/w1/run"): return ok(#"{"running":true,"pid":4,"port":3010,"logTail":""}"#)
            case ("POST", "/native/workspaces/w1/archive"): return ok(#"{"workspace":{"id":"w1","projectId":"p","name":"duck","path":"/w","branch":"b","state":"archived","port":3010}}"#)
            default: return HTTPResponse(status: 404, body: Data(#"{"error":"nope"}"#.utf8))
            }
        }
        let c = client(stub)
        let g = try await c.gitStatus(sessionId: "s1")
        #expect(g.ahead == 2 && g.dirty == 1 && g.pr?.number == 9 && g.pr?.mergeable == nil && g.pr?.checks == .running)
        let a = try await c.gitAction(sessionId: "s1", action: .createPR)
        #expect(a.queued && a.prompt == "Open it." && a.sessionId == nil)
        #expect(try await c.merge(sessionId: "s1") == "rebase")
        #expect(try await c.workspaceLog(workspaceId: "w1").log == "boom")
        #expect(try await c.runStatus(workspaceId: "w1").port == 3010)
        #expect(try await c.setRun(workspaceId: "w1", start: false).running)
        #expect(try await c.archive(workspaceId: "w1", force: true).state == "archived")
        let sent = stub.requests
        #expect(sent.allSatisfy { $0.headers["x-squeak-token"] == "tok" })
        func body(_ path: String) -> NativeJSON? { sent.first { $0.url.path == path && $0.method == "POST" }?.body.flatMap { NativeJSON.parse(String(decoding: $0, as: UTF8.self)) } }
        #expect(body("/native/sessions/s1/actions/merge")?["confirm"]?.bool == true)
        #expect(body("/native/workspaces/w1/run")?["action"]?.string == "stop")
        #expect(body("/native/workspaces/w1/archive")?["force"]?.bool == true)
    }

    @Test func aRefusalCarriesTheHostsSentence() async {
        let stub = Stub { _ in HTTPResponse(status: 409, body: Data(#"{"error":"The checks are failing. Fix them before merging."}"#.utf8)) }
        do {
            _ = try await client(stub).merge(sessionId: "s1")
            Issue.record("expected a refusal")
        } catch let e as NativeHostError {
            #expect(e == .http(409, "The checks are failing. Fix them before merging."))
        } catch { Issue.record("wrong error") }
    }

    @Test func settingsGetAndPatch() async throws {
        let stub = Stub { _ in HTTPResponse(status: 200, body: Data(#"{"settings":{"prompts":{}},"effective":{"branchPrefix":"me/","mergeMethod":"squash","prompts":{}},"sources":{},"defaultPrompts":{}}"#.utf8)) }
        let c = client(stub)
        _ = try await c.patchProjectSettings(projectId: "p1", body: ["mergeMethod": .string("merge")])
        let s = try await c.projectSettings(projectId: "p1")
        #expect(s.effective.branchPrefix == "me/")
        #expect(stub.requests.map(\.method) == ["PATCH", "GET"] && stub.requests[0].url.path == "/native/projects/p1/settings")
    }

    @Test func aWorkspaceDecodesItsPortAndState() throws {
        let w = try JSONDecoder().decode(NativeWorkspace.self, from: Data(#"{"id":"w","projectId":"p","name":"n","path":"/p","branch":"b","state":"setting_up","port":3000}"#.utf8))
        #expect(w.state == "setting_up" && w.port == 3000)
        let old = try JSONDecoder().decode(NativeWorkspace.self, from: Data(#"{"id":"w","projectId":"p","name":"n","path":"/p","branch":"b"}"#.utf8))
        #expect(old.state == "ready" && old.port == nil)
    }
}
