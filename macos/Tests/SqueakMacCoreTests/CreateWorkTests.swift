import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct CreateWorkTests {
    private func project(_ id: String, _ name: String) -> NativeProject {
        NativeProject(id: id, name: name, rootPath: "/r/\(name)", defaultBranch: "main")
    }

    private func form(text: String = "fix it", projects: [NativeProject]? = nil, models: Bool = true) -> NativeNewChatForm {
        var f = NativeNewChatForm()
        f.setProjects(projects ?? [project("p1", "alpha")])
        if models { f.setModels([DaemonChatModel(id: "opus", agent: "claude", label: "Opus", levels: ["low"], defaultLevel: "low")]) }
        f.text = text
        return f
    }

    @Test func sectionsLeadWithAddProjectWhenThereAreNone() {
        let none = CreateWork.sections(projectCount: 0)
        #expect(none.addProjectLeads && !none.startWorkEnabled && none.showsPonds)
        #expect(none.startWorkNote == CreateWork.addProjectFirst)
        let some = CreateWork.sections(projectCount: 2)
        #expect(!some.addProjectLeads && some.startWorkEnabled && some.showsPonds && some.startWorkNote == nil)
    }

    @Test func projectsWithRecentWorkComeFirstThenHostOrder() {
        let all = [project("1", "zeta"), project("2", "Alpha"), project("3", "mid"), project("4", "beta")]
        let ordered = CreateWork.orderedProjects(all, activityOrder: ["alpha", "mid"])
        #expect(ordered.map(\.id) == ["2", "3", "1", "4"])
    }

    @Test func startNeedsProjectModelWordsAndAParsingSource() {
        #expect(CreateWork.canStart(form: form(), kind: .newBranch, input: ""))
        #expect(!CreateWork.canStart(form: form(text: "  "), kind: .newBranch, input: ""))
        #expect(!CreateWork.canStart(form: form(models: false), kind: .newBranch, input: ""))
        #expect(!CreateWork.canStart(form: form(projects: []), kind: .newBranch, input: ""))
        #expect(!CreateWork.canStart(form: form(), kind: .pullRequest, input: "not a number"))
        #expect(CreateWork.canStart(form: form(), kind: .pullRequest, input: "#12"))
        #expect(!CreateWork.canStart(form: form(), kind: .existingBranch, input: "has space"))
        #expect(CreateWork.canStart(form: form(), kind: .existingBranch, input: "feature/x"))
    }

    @Test func anIssueMayStartWithoutWords() {
        #expect(CreateWork.canStart(form: form(text: ""), kind: .issue, input: "45"))
        #expect(!CreateWork.canStart(form: form(text: ""), kind: .issue, input: "x"))
    }

    @Test func sourcesMatchWhatTheHostTakes() {
        #expect(CreateStartKind.newBranch.source(from: "anything") == nil)
        #expect(CreateStartKind.existingBranch.source(from: "dev") == .branch("dev"))
        #expect(CreateStartKind.pullRequest.source(from: "https://github.com/o/r/pull/7") == .pullRequest(7))
        #expect(CreateStartKind.issue.source(from: "#45") == .issue(45))
    }

    @Test func sessionsCarryTheChoices() throws {
        let f = form()
        let fresh = try #require(CreateWork.newBranchSession(form: f))
        #expect(fresh.newWorkspace && fresh.cwd == nil && fresh.projectId == "p1" && fresh.text == "fix it")
        let ws = NativeWorkspace(id: "w", projectId: "p1", name: "n", path: "/w", branch: "b")
        let made = try #require(CreateWork.session(form: f, workspace: ws, issuePrompt: "Issue #4: bug"))
        #expect(made.cwd == "/w" && !made.newWorkspace && made.text == "Issue #4: bug\n\nfix it")
        let bare = try #require(CreateWork.session(form: form(text: ""), workspace: ws, issuePrompt: "Issue #4: bug"))
        #expect(bare.text == "Issue #4: bug")
        #expect(CreateWork.session(form: form(text: ""), workspace: ws, issuePrompt: nil) == nil)
    }

    @Test func historyRecordsTheCreatePage() {
        var h = NavHistory<WorkbenchPlace>()
        h.visit(nil); h.visit(.create); h.visit(nil)
        #expect(h.back() == .some(.create))
        #expect(h.back() == .some(nil))
        #expect(h.forward() == .some(.create))
    }
}
