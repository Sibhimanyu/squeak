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

    @Test func nameFillsFromTheHostUnlessTyped() {
        var f = NewBranchForm(defaultBranch: "trunk")
        #expect(f.name == "" && f.canCreate == false && f.nameToSend == nil)
        let s = NativeStreamSuggestion(title: "Detached HEAD Duck", slug: "detached-head-duck", branch: "me/detached-head-duck")
        f.applySuggestion(s)
        #expect(f.name == "Detached HEAD Duck" && f.nameToSend == "Detached HEAD Duck" && f.branchToSend == nil && f.canCreate)
        f.setName("My own")
        f.applySuggestion(NativeStreamSuggestion(title: "Quiet Creek", slug: "quiet-creek", branch: "me/quiet-creek"))
        #expect(f.name == "My own")
        f.applySuggestion(NativeStreamSuggestion(title: "Quiet Creek", slug: "quiet-creek", branch: "me/quiet-creek"), force: true)
        #expect(f.name == "Quiet Creek")
        f.setName("")
        #expect(f.nameToSend == nil && f.canCreate)
    }

    @Test func anOlderHostStillTakesTheTypedNameAsABranch() {
        var f = NewBranchForm(defaultBranch: "trunk")
        f.setName("feat/x")
        #expect(f.branchToSend == "feat/x" && f.nameToSend == nil)
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
        var f = NewBranchForm(defaultBranch: "trunk")
        f.setName("teal")
        #expect(f.startLabel == "trunk" && f.canCreate)
        f.setName(" ")
        #expect(!f.canCreate)
        f.setName("teal")
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
        let open = NewBranchForm(defaultBranch: "main", preset: .openBranch)
        #expect(open.start == .openBranch("") && !open.showsName && !open.canCreate)
        #expect(NewBranchPreset.openBranch.title == "Open stream" && NewBranchPreset.openPullRequest.title == "Open pull request")
        #expect(NewBranchPreset.forIssue.title == "New stream for issue" && NewBranchPreset.newFromDefault.title == "New stream")
        var o = open
        o.start = .openBranch("feature/x")
        #expect(o.canCreate && o.start.source == .branch("feature/x"))
        var from = NewBranchForm(defaultBranch: "main", preset: .newFrom(base: "dev"))
        from.setName("x")
        #expect(from.start.source == .base("dev") && from.canCreate)
    }

    @Test func branchNameShowsAndIsSentPerSource() {
        var f = NewBranchForm(defaultBranch: "main")
        f.setName(" feature/x ")
        #expect(f.branchToSend == "feature/x")
        f.start = .issue("3")
        #expect(f.showsName && f.branchToSend == "feature/x")
        f.start = .openBranch("dev")
        #expect(!f.showsName && f.branchToSend == nil && f.canCreate)
        f.start = .pullRequest("#4")
        #expect(!f.showsName && f.branchToSend == nil)
        f.start = .defaultBranch
        f.name = " "
        #expect(f.branchToSend == nil && !f.canCreate)
    }

    @Test func eachSourceHasItsPicker() {
        #expect(NewBranchStart.defaultBranch.picker == nil)
        #expect(NewBranchStart.branch("").picker == .branches && NewBranchStart.openBranch("").picker == .branches)
        #expect(NewBranchStart.pullRequest("").picker == .pulls && NewBranchStart.issue("").picker == .issues)
        #expect(NewBranchStart.input(item: NativePickItem(number: 7, title: "t")) == "#7")
    }

    @Test func branchPickerFiltersAndDisablesOpenOnes() {
        let list = [NativeBranchChoice(name: "main", current: true, checkedOut: true), NativeBranchChoice(name: "feature/Login"),
                    NativeBranchChoice(name: "fix-cache", remote: true)]
        let rows = PickerRows.branches(list, query: " LOGIN ", opening: true)
        #expect(rows.map(\.id) == ["feature/Login"] && !rows[0].disabled)
        let all = PickerRows.branches(list, query: "", opening: true)
        #expect(all.map(\.disabled) == [true, false, false] && all[0].note == "already open")
        #expect(PickerRows.branches(list, query: "", opening: false).allSatisfy { !$0.disabled })
    }

    @Test func itemPickerFiltersAndLabels() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let a = NativePickItem(number: 12, title: "Fix cache", author: "ana", updatedAt: now.addingTimeInterval(-3 * 86400))
        let b = NativePickItem(number: 130, title: "Add login", author: "bo", updatedAt: now.addingTimeInterval(-90))
        #expect(PickerRows.items([a, b], query: "#13").map(\.number) == [130])
        #expect(PickerRows.items([a, b], query: "ANA").map(\.number) == [12])
        #expect(PickerRows.items([a, b], query: "login").map(\.number) == [130])
        #expect(PickerRows.items([a, b], query: "").count == 2)
        #expect(PickerRows.line(a, now: now) == "#12 Fix cache \u{00B7} ana \u{00B7} 3d")
        #expect(PickerRows.line(b, now: now) == "#130 Add login \u{00B7} bo \u{00B7} 1m")
        #expect(PickerRows.unavailableLine(NativePickList(available: false, reason: "no gh")) == "no gh")
        #expect(PickerRows.unavailableLine(NativePickList(available: false)) != nil)
        #expect(PickerRows.unavailableLine(NativePickList()) == nil)
    }

    private static let composerModels: [DaemonChatModel] = [
        DaemonChatModel(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: ["low", "medium", "high"], defaultLevel: "medium"),
        DaemonChatModel(id: "sonnet-5-5", agent: "claude", label: "Sonnet 5.5", levels: ["low", "medium", "high"], defaultLevel: "medium"),
        DaemonChatModel(id: "haiku-4-5", agent: "claude", label: "Haiku 4.5", levels: []),
        DaemonChatModel(id: "gpt-5.5", agent: "codex", label: "GPT 5.5", levels: ["low", "high"], defaultLevel: "high"),
    ]

    @Test func composerShowsThreePresetsForClaudeAndNoneForCodex() {
        var f = NativeNewChatForm()
        f.setModels(Self.composerModels)
        #expect(f.agent == .claude && f.presets == [.best, .balanced, .save])
        #expect(f.presetChoices == [.best, .balanced, .save]) // Custom only once a preset was edited away
        f.choose(agent: .codex)
        #expect(f.presets.isEmpty && f.presetChoices.isEmpty && f.modelId == "gpt-5.5")
    }

    @Test func pickingAPresetSetsModelLevelAndSplit() {
        var f = NativeNewChatForm()
        f.setModels(Self.composerModels)
        f.apply(preset: .save)
        #expect(f.modelId == "sonnet-5-5" && f.effort == "low")
        #expect(f.splitOn && f.splitCode == "haiku" && f.splitRun == "haiku" && !f.planFirst)
        #expect(f.activePreset == .save)
        #expect(NewThreadRules.split(agent: f.agent, on: f.splitOn, code: f.splitCode, run: f.splitRun) == WorkSplit(code: "haiku", run: "haiku"))
        f.apply(preset: .best)
        #expect(f.modelId == "opus-5-5-1m" && f.effort == "high" && f.splitCode == "opus" && f.splitRun == "sonnet")
        f.splitRun = nil // edited by hand
        #expect(f.activePreset == .custom && f.presetChoices == [.best, .balanced, .save, .custom])
    }

    @Test func editedPresetsFromTheMacsCopyAreUsedWithTheirNames() {
        let defaults = UserDefaults(suiteName: "squeak.composer.\(UUID().uuidString)")!
        let prefs = ChatPresetPreferences(defaults: defaults)
        prefs.setTitle("Cheap", for: .save)
        prefs.setSetup(ChatSetup(modelId: "haiku-4-5", code: "haiku", planFirst: true), for: .save, agent: .claude, models: Self.composerModels)
        var f = NativeNewChatForm()
        f.setModels(Self.composerModels)
        f.loadPresets(prefs)
        #expect(f.presetTitle(.save) == "Cheap")
        f.apply(preset: .save)
        #expect(f.modelId == "haiku-4-5" && f.effort == nil && f.splitCode == "haiku" && f.planFirst)
        #expect(f.activePreset == .save)
    }

    @Test func conductorSplitCarriesPlanFirst() {
        #expect(NewThreadRules.split(agent: .claude, on: true, code: "sonnet", run: nil, planFirst: true) == WorkSplit(code: "sonnet", planFirst: true))
        #expect(NewThreadRules.split(agent: .claude, on: true, code: nil, run: nil, planFirst: true) == nil)
    }

    @Test func splitOnlyForClaudeWithAWorker() {
        #expect(NewThreadRules.offersSplit(agent: .claude) && !NewThreadRules.offersSplit(agent: .codex))
        #expect(NewThreadRules.split(agent: .claude, on: true, code: "sonnet", run: nil) == WorkSplit(code: "sonnet"))
        #expect(NewThreadRules.split(agent: .claude, on: false, code: "sonnet", run: nil) == nil)
        #expect(NewThreadRules.split(agent: .claude, on: true, code: nil, run: nil) == nil)
        #expect(NewThreadRules.split(agent: .codex, on: true, code: "sonnet", run: "haiku") == nil)
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
