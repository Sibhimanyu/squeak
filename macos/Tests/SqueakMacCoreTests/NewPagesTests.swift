import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct NewPagesTests {
    @Test func eachEntryOpensItsPage() {
        #expect(NewPages.page(for: .sidebarCreate) == .pond)
        #expect(NewPages.page(for: .pondPlus(projectId: "p")) == .branch(projectId: "p", source: .newFromDefault))
        #expect(NewPages.page(for: .pondPlus(projectId: "p", source: .forIssue)) == .branch(projectId: "p", source: .forIssue))
        #expect(NewPages.page(for: .branchPlus(projectId: "p", workspaceId: "w")) == .thread(projectId: "p", workspaceId: "w"))
        #expect(NewPages.page(for: .newThreadShortcut) == .thread(projectId: nil, workspaceId: nil))
        #expect(NewPages.page(for: .conductorWorkspacePlus(workspaceId: "c")) == .conductorThread(workspaceId: "c"))
    }

    @Test func branchNamesAreTheFirstFreeBird() {
        #expect(BranchNames.suggest(taken: []) == "mallard")
        #expect(BranchNames.suggest(taken: ["mallard", "Teal"]) == "wigeon")
        #expect(BranchNames.suggest(taken: BranchNames.birds) == "mallard-2")
        #expect(BranchNames.suggest(taken: BranchNames.birds + ["mallard-2"]) == "teal-2")
    }

    @Test func pondFormFillsNameFromFolderUnlessTyped() {
        var f = NewPondForm()
        #expect(!f.canCreate && f.buttonTitle == "Create pond")
        f.chooseFolder("/Users/a/orchard")
        #expect(f.name == "orchard" && f.canCreate)
        f.setName("Mine")
        f.chooseFolder("/Users/a/other")
        #expect(f.name == "Mine")
    }

    @Test func pondFormRulesPerChoice() {
        var f = NewPondForm()
        f.kind = .clone
        #expect(!f.canCreate)
        f.cloneURL = " owner/repo "
        #expect(f.canCreate)
        f.kind = .invite
        #expect(!f.canCreate && f.buttonTitle == "Join pond")
        f.inviteCode = "two words"
        #expect(!f.canCreate)
        f.inviteCode = "abc123"
        #expect(f.canCreate)
    }

    @Test func branchFormStartsFromTheDefault() {
        var f = NewBranchForm(defaultBranch: "trunk", taken: ["mallard"])
        #expect(f.name == "teal" && f.startLabel == "trunk" && f.canCreate)
        f.name = " "
        #expect(!f.canCreate)
        f.name = "teal"
        f.start = .pullRequest("nope")
        #expect(!f.canCreate && !f.showsName)
        f.start = .pullRequest("#12")
        #expect(f.canCreate && f.start.source == .pullRequest(12))
        f.start = .issue("45")
        #expect(f.start.source == .issue(45))
        f.start = .branch("dev")
        #expect(f.start.source == .base("dev") && f.showsName)
    }

    @Test func presetsOpenWithTheChoiceAlreadyMade() {
        let open = NewBranchForm(defaultBranch: "main", taken: [], preset: .openBranch)
        #expect(open.start == .openBranch("") && !open.showsName && !open.canCreate)
        #expect(NewBranchPreset.openBranch.title == "Open branch" && NewBranchPreset.openPullRequest.title == "Open pull request")
        #expect(NewBranchPreset.forIssue.title == "New branch for issue" && NewBranchPreset.newFromDefault.title == "New branch")
        var o = open
        o.start = .openBranch("feature/x")
        #expect(o.canCreate && o.start.source == .branch("feature/x"))
        let from = NewBranchForm(defaultBranch: "main", taken: [], preset: .newFrom(base: "dev"))
        #expect(from.start.source == .base("dev") && from.canCreate)
    }

    @Test func aTypedNameIsFlaggedAsIgnoredOnlyWhereItMatters() {
        var f = NewBranchForm(defaultBranch: "main", taken: [])
        let suggested = f.name
        #expect(!f.nameIsIgnored(suggested: suggested))
        f.name = "mine"
        #expect(f.nameIsIgnored(suggested: suggested))
        f.start = .issue("3")
        #expect(!f.nameIsIgnored(suggested: suggested))
    }

    @Test func startNeedsPlaceModelWordsAndNothingStarting() {
        #expect(NewThreadRules.canStart(text: "go", hasPlace: true, hasModel: true, starting: false))
        #expect(!NewThreadRules.canStart(text: "  ", hasPlace: true, hasModel: true, starting: false))
        #expect(!NewThreadRules.canStart(text: "go", hasPlace: false, hasModel: true, starting: false))
        #expect(!NewThreadRules.canStart(text: "go", hasPlace: true, hasModel: false, starting: false))
        #expect(!NewThreadRules.canStart(text: "go", hasPlace: true, hasModel: true, starting: true))
        #expect(!NewThreadRules.canStart(text: "go", hasPlace: true, hasModel: true, starting: false, connected: false))
        #expect(!NewThreadRules.canStart(text: String(repeating: "x", count: NewChatForm.maxLength + 1), hasPlace: true, hasModel: true, starting: false))
    }

    @Test func quickPanelOpensOnTheNewestThreadsBranch() {
        func w(_ id: String, _ path: String, _ state: String = "ready") -> NativeWorkspace {
            NativeWorkspace(id: id, projectId: "p", name: id, path: path, branch: id, state: state)
        }
        let all = [w("a", "/a"), w("b", "/b"), w("c", "/c", "archived")]
        #expect(QuickPlace.defaultWorkspace(recentCwds: ["/c", "/a", "/b"], workspaces: all)?.id == "a")
        #expect(QuickPlace.defaultWorkspace(recentCwds: ["/zzz"], workspaces: all)?.id == "b")
        #expect(QuickPlace.defaultWorkspace(recentCwds: [], workspaces: []) == nil)
    }

    @Test func historyRecordsTheNewPondPage() {
        var h = NavHistory<WorkbenchPlace>()
        h.visit(nil); h.visit(.create); h.visit(nil)
        #expect(h.back() == .some(.create))
        #expect(h.back() == .some(nil))
        #expect(h.forward() == .some(.create))
    }
}
