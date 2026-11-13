import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The plain frame the New pond and New branch pages share: a title, the content, centred.
private struct NewPageFrame<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                Text(title).font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                content
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(.horizontal, Space.xl).padding(.top, Space.l).padding(.bottom, Space.xl)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .screen(title)
    }
}

private struct ProblemLine: View {
    let text: String
    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Lucide(.triangleAlert, size: Metrics.icon, color: Theme.negative)
            Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: New pond

@MainActor @Observable
final class NewPondState {
    var form = NewPondForm(personName: NSFullUserName())
    var busy = false
    var error: String?
    /// The pending request this page sent (or found for the same invite): the waiting card shows instead of the form.
    var waitingPondId: String?
    /// The request is on its way ("Joining\u{2026}").
    var joining = false
    /// One line above the choices ("Make a pond first: …") when a thread or stream led here.
    var notice: String?

    func reset() { form = NewPondForm(personName: NSFullUserName()); busy = false; error = nil; waitingPondId = nil; joining = false; notice = nil }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "Choose any folder. It becomes a pond; Git is not needed."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        form.chooseFolder(url.path)
    }

    func create(model: AppModel) {
        guard form.canCreate, !busy, !joining else { return }
        // The same invite while its request is still waiting shows the card; no second request goes out.
        if form.kind == .invite, let pending = PondJoinWaiting.pending(forInvite: form.inviteCode, in: PondsModel.shared.ponds) {
            waitingPondId = pending.id
            return
        }
        busy = true
        joining = form.kind == .invite
        error = nil
        let f = form
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false; joining = false }
            switch f.kind {
            case .blank:
                let home = NSHomeDirectory()
                guard let path = PondFolder.path(home: home, name: f.name), let name = PondFolder.sanitized(f.name) else {
                    error = PondFolder.nameProblem(f.name) ?? "Give the pond a name."
                    return
                }
                var existing = PondFolder.Existing.missing
                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: path, isDirectory: &isDir) {
                    let items = isDir.boolValue ? (try? FileManager.default.contentsOfDirectory(atPath: path)) : ["file"]
                    existing = (items ?? ["unreadable"]).isEmpty ? .empty : .notEmpty
                }
                if let refusal = PondFolder.refusal(for: existing, name: f.name) { error = refusal; return }
                do { try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true) } catch {
                    self.error = "Squeak couldn\u{2019}t make ~/Squeak/\(name)."
                    return
                }
                let (project, problem) = await ProjectActions.shared.add(model, path: path, name: name)
                finish(model, project, problem)
            case .folder:
                let (project, problem) = await ProjectActions.shared.add(model, path: f.folderPath ?? "", name: f.name)
                finish(model, project, problem)
            case .clone:
                let (project, problem) = await ProjectActions.shared.clone(model, url: f.cloneURL.trimmingCharacters(in: .whitespacesAndNewlines), name: f.name)
                finish(model, project, problem)
            case .invite:
                let ponds = PondsModel.shared
                let name = f.memberName(fallback: NSFullUserName())
                guard let code = PondInviteText.cleaned(f.inviteCode),
                      let r = await ponds.join(code: code, name: name) else {
                    error = PondsModel.shared.note ?? "That invite didn\u{2019}t work."
                    return
                }
                await ponds.refresh()
                if r.isPending { waitingPondId = r.pondId } else {
                    NewChatController.shared.hide()
                    ponds.route = .home(project: ponds.ponds.first { $0.id == r.pondId }?.name ?? "")
                }
            }
        }
    }

    private func finish(_ model: AppModel, _ project: NativeProject?, _ problem: String?) {
        guard let project else { error = problem ?? "Squeak couldn\u{2019}t make that pond."; return }
        NewChatController.shared.hide()
        PondsModel.shared.route = .home(project: project.name)
    }
}

struct NewPondPage: View {
    var state: NewPondState
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var state = state
        NewPageFrame(title: "New pond") {
            VStack(alignment: .leading, spacing: Space.l) {
                if let notice = state.notice { Text(notice).font(Typo.body).foregroundStyle(Theme.muted) }
                if let id = state.waitingPondId, let pond = PondsModel.shared.ponds.first(where: { $0.id == id }) {
                    JoinWaitingCard(pond: pond) { NewChatController.shared.hide(); state.reset() }
                } else {
                formBody
                }
            }
            .onChange(of: PondsModel.shared.ponds.first { $0.id == state.waitingPondId }?.status) { _, status in
                // Approved while the page is open: it is a normal pond now.
                if status == "active" || status == "local", let id = state.waitingPondId, let p = PondsModel.shared.ponds.first(where: { $0.id == id }) {
                    NewChatController.shared.hide(); state.reset(); PondsModel.shared.route = .home(project: p.name)
                }
            }
        }
    }

    @ViewBuilder private var formBody: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: Space.l) {
            Group {
                if state.form.kind != .invite {
                    NCField("Name") {
                        TextField("Pond name",
                                  text: Binding(get: { state.form.name }, set: { state.form.setName($0) }))
                            .textFieldStyle(NewPageTextFieldStyle()).accessibilityLabel("Name")
                    }
                }
                VStack(spacing: Space.s) {
                    choice(.blank, icon: .plus) {
                        Text(verbatim: PondFolder.path(home: "~", name: state.form.name).map { "Makes the folder \($0)." } ?? "Makes a folder in ~/Squeak with that name.")
                            .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                    }
                    choice(.folder, icon: .folder) {
                        HStack(spacing: 8) {
                            Button("Choose folder\u{2026}") { state.chooseFolder() }.buttonStyle(SecondaryButtonStyle())
                            if let p = state.form.folderPath {
                                Text(verbatim: p).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                            }
                        }
                    }
                    choice(.clone, icon: .gitBranch) {
                        TextField("owner/repo or a git URL", text: $state.form.cloneURL).textFieldStyle(NewPageTextFieldStyle())
                            .onSubmit { state.create(model: model) }.accessibilityLabel("Repository to clone")
                    }
                    choice(.invite, icon: .users) {
                        TextField("Paste the invite link or code", text: $state.form.inviteCode).textFieldStyle(NewPageTextFieldStyle(font: Typo.code))
                            .onSubmit { state.create(model: model) }.accessibilityLabel("Invite link or code")
                    }
                }
                // The link or code comes first; the name that people in the pond will see comes after it.
                if state.form.kind == .invite {
                    NCField("Your name (what people in the pond see)") {
                        TextField(NSFullUserName(), text: $state.form.joinName)
                            .textFieldStyle(NewPageTextFieldStyle()).accessibilityLabel("Your name")
                    }
                }
                if let e = state.error { ProblemLine(text: e) }
                HStack {
                    Spacer()
                    if state.busy { ProgressView().controlSize(.small) }
                    Button(state.joining ? "Joining\u{2026}" : state.form.buttonTitle) { state.create(model: model) }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                        .disabled(!state.form.canCreate || state.busy || state.joining)
                }
            }
        }
    }

    private func choice<C: View>(_ kind: NewPondKind, icon: LucideName, @ViewBuilder _ content: () -> C) -> some View {
        let on = state.form.kind == kind
        return VStack(alignment: .leading, spacing: Space.s) {
            Button { state.form.kind = kind } label: {
                HStack(spacing: 10) {
                    Lucide(icon, size: 18, color: on ? Theme.ink : Theme.muted)
                    Text(kind.title).font(Typo.label).foregroundStyle(Theme.ink)
                    Spacer()
                    if on { Lucide(.check, size: Metrics.icon, color: Theme.ink) }
                }
                .frame(minHeight: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
            if on { content() }
        }
        .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(on ? Theme.selected : Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? Theme.lineStrong : Theme.line))
    }
}

// MARK: New branch

@MainActor @Observable
final class NewBranchState {
    var project: NativeProject?
    var form = NewBranchForm(defaultBranch: "main")
    var rolling = false
    var preset: NewBranchPreset = .newFromDefault
    var busy = false
    var error: String?
    // The pickers: one list per source, loaded when the page needs it.
    var query = ""
    var loadingList = false
    var fetching = false
    var branchList: [NativeBranchChoice]?
    var pulls: NativePickList?
    var issues: NativePickList?
    var listProblem: String?

    func loadPicker(model: AppModel, fetch: Bool = false) {
        guard let kind = form.start.picker, let project, !model.demoMode else { return }
        if fetch { fetching = true } else if loaded(kind) { return }
        loadingList = !fetch
        listProblem = nil
        let id = project.id
        Task { [weak self] in
            guard let self else { return }
            defer { loadingList = false; fetching = false }
            do {
                switch kind {
                case .branches: branchList = try await model.nativeHost.branches(projectId: id, fetch: fetch)
                case .pulls: pulls = try await model.nativeHost.pulls(projectId: id)
                case .issues: issues = try await model.nativeHost.issues(projectId: id)
                }
            } catch let e as NativeHostError { listProblem = e.reason }
            catch { listProblem = "Squeak couldn\u{2019}t load that list." }
        }
    }

    private func loaded(_ kind: PickerKind) -> Bool {
        switch kind {
        case .branches: branchList != nil
        case .pulls: pulls != nil
        case .issues: issues != nil
        }
    }

    /// Asks the host for a name and puts it in the field (the dice replaces what is there). A host too old to
    /// suggest leaves the field empty with its placeholder.
    func suggestName(model: AppModel, projectId: String, force: Bool = false) {
        guard !model.demoMode else { return }
        rolling = true
        Task { [weak self] in
            guard let self else { return }
            defer { rolling = false }
            guard let s = try? await model.nativeHost.suggestStream(projectId: projectId), project?.id == projectId else { return }
            form.applySuggestion(s, force: force)
        }
    }

    func prepare(model: AppModel, projectId: String, preset: NewBranchPreset = .newFromDefault) {
        self.preset = preset
        busy = false
        error = nil
        query = ""
        branchList = nil; pulls = nil; issues = nil; listProblem = nil
        let p = model.native.projects.first { $0.id == projectId }
        project = p
        form = NewBranchForm(defaultBranch: p?.defaultBranch ?? "main", preset: preset)
        loadPicker(model: model)
        suggestName(model: model, projectId: projectId)
        if p == nil {
            Task { [weak self] in
                guard let self, let list = await model.nativeProjects(), let found = list.first(where: { $0.id == projectId }) else { return }
                project = found
                form = NewBranchForm(defaultBranch: found.defaultBranch, preset: preset)
                loadPicker(model: model)
                suggestName(model: model, projectId: projectId)
            }
        }
    }

    func create(model: AppModel) {
        guard let project, form.canCreate, !busy else { return }
        if model.demoMode { error = "Demo data: no stream is made."; return }
        busy = true
        error = nil
        let source = form.start.source
        let branch = form.branchToSend
        let name = form.nameToSend
        Task { [weak self] in
            guard let self else { return }
            do {
                let made: NativeWorkspace
                var prompt: String?
                if let source {
                    let m = try await model.nativeHost.createWorkspace(projectId: project.id, from: source, branch: branch, name: name)
                    made = m.workspace
                    prompt = m.prompt
                } else {
                    made = try await model.nativeHost.createWorkspace(projectId: project.id, branch: branch, name: name)
                }
                AppLog.info("native workspace made")
                await model.refreshNativeWorkspaces()
                busy = false
                // The new branch opens on New thread with the message box focused (an issue brings its first message).
                NewChatController.shared.open(.thread(projectId: project.id, workspaceId: made.id), text: prompt)
            } catch {
                busy = false
                self.error = NativeWorkspaceMaking.problem(error)
            }
        }
    }
}

struct NewBranchPage: View {
    var state: NewBranchState
    @Environment(AppModel.self) private var model

    private func setInput(_ text: String) { state.form.start = state.form.start.with(input: text) }

    private var typedInput: some View {
        TextField(state.form.start.placeholder,
                  text: Binding(get: { state.form.start.input }, set: { setInput($0) }))
            .textFieldStyle(NewPageTextFieldStyle()).onSubmit { state.create(model: model) }
            .accessibilityLabel(state.form.start.menuTitle)
    }

    private func quiet(_ text: String) -> some View {
        Text(verbatim: text).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
    }

    /// The picker for the chosen source: a search field and a list, or one quiet line and a typed fallback.
    @ViewBuilder private var picker: some View {
        let start = state.form.start
        if let kind = start.picker {
            VStack(alignment: .leading, spacing: 8) {
                switch kind {
                case .branches:
                    if let problem = state.listProblem { quiet(problem); typedInput }
                    else if let list = state.branchList {
                        searchRow(showFetch: true)
                        let rows = PickerRows.branches(list, query: state.query, opening: { if case .openBranch = start { true } else { false } }())
                        if list.isEmpty { quiet("This pond has no branches yet.") }
                        else if rows.isEmpty { quiet("Nothing matches.") }
                        else {
                            pickList(rows.map { r in
                                PickRow(id: r.id, title: r.branch.name, trailing: r.note ?? r.branch.lastCommitAt.map { PickerRows.age($0) },
                                        disabled: r.disabled, selected: start.input == r.branch.name) { setInput(r.branch.name) }
                            })
                        }
                    } else { quiet("Loading branches\u{2026}") }
                case .pulls, .issues:
                    let list = kind == .pulls ? state.pulls : state.issues
                    let noun = kind == .pulls ? "pull requests" : "issues"
                    if let problem = state.listProblem { quiet(problem); typedInput }
                    else if let list {
                        if let line = PickerRows.unavailableLine(list) { quiet(line); typedInput }
                        else {
                            searchRow(showFetch: false)
                            let rows = PickerRows.items(list.items, query: state.query)
                            if list.items.isEmpty { quiet("No open \(noun).") }
                            else if rows.isEmpty { quiet("Nothing matches.") }
                            else {
                                pickList(rows.map { i in
                                    PickRow(id: String(i.number), title: PickerRows.line(i), trailing: nil, disabled: false,
                                            selected: start.input == NewBranchStart.input(item: i)) { setInput(NewBranchStart.input(item: i)) }
                                })
                            }
                        }
                    } else { quiet("Loading \(noun)\u{2026}") }
                }
            }
        }
    }

    private func searchRow(showFetch: Bool) -> some View {
        @Bindable var state = state
        return HStack(spacing: 8) {
            TextField("Search", text: $state.query).textFieldStyle(NewPageTextFieldStyle()).accessibilityLabel("Search")
            if showFetch {
                Button(state.fetching ? "Fetching\u{2026}" : "Fetch") { state.loadPicker(model: model, fetch: true) }
                    .buttonStyle(SecondaryButtonStyle()).disabled(state.fetching)
                    .help("Fetch the latest branches from origin")
            }
        }
    }

    private struct PickRow: Identifiable {
        let id: String
        let title: String
        let trailing: String?
        let disabled: Bool
        let selected: Bool
        let action: () -> Void
    }

    private func pickList(_ rows: [PickRow]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(rows) { r in
                    Button(action: r.action) {
                        HStack(spacing: 8) {
                            Text(verbatim: r.title).font(Typo.body).lineLimit(1).truncationMode(.tail)
                                .foregroundStyle(r.disabled ? Theme.subtle : Theme.ink)
                            Spacer(minLength: 8)
                            if let t = r.trailing { Text(verbatim: t).font(Typo.meta).foregroundStyle(Theme.muted) }
                            if r.selected { Lucide(.check, size: Metrics.icon, color: Theme.ink) }
                        }
                        .padding(.horizontal, 10).frame(minHeight: 30).contentShape(Rectangle())
                        .background(r.selected ? Theme.selected : Color.clear)
                    }
                    .buttonStyle(.plain).disabled(r.disabled)
                    .accessibilityAddTraits(r.selected ? .isSelected : [])
                }
            }
        }
        .frame(maxHeight: 220)
        .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    var body: some View {
        @Bindable var state = state
        NewPageFrame(title: state.preset.title) {
            VStack(alignment: .leading, spacing: Space.l) {
                Text(verbatim: state.project?.name ?? "No pond").font(Typo.label).foregroundStyle(Theme.muted)
                if state.form.showsName {
                    NCField("Name") {
                        HStack(spacing: 8) {
                            TextField(state.form.hostNamesStreams ? "Name" : "Branch name",
                                      text: Binding(get: { state.form.name }, set: { state.form.setName($0) }))
                                .textFieldStyle(NewPageTextFieldStyle())
                                .onSubmit { state.create(model: model) }.accessibilityLabel("Name")
                            if state.form.hostNamesStreams, let project = state.project {
                                Button { state.suggestName(model: model, projectId: project.id, force: true) } label: {
                                    Lucide(.refreshCw, size: Metrics.icon, color: Theme.muted)
                                }
                                .buttonStyle(.plain).disabled(state.rolling)
                                .help("Another name").accessibilityLabel("Another name")
                            }
                        }
                    }
                }
                if state.preset.namesItself {
                    NCField(state.form.start.menuTitle) { picker }
                } else {
                    NCField("Start from") {
                        HStack(spacing: 10) {
                            Text(verbatim: state.form.startLabel).font(Typo.body).foregroundStyle(Theme.ink)
                            SqueakMenu("Start from\u{2026}") {
                                Button(NewBranchStart.defaultBranch.menuTitle) { state.form.start = .defaultBranch; state.query = "" }
                                Button(NewBranchStart.branch("").menuTitle) { state.form.start = .branch(""); state.query = "" }
                                Button(NewBranchStart.pullRequest("").menuTitle) { state.form.start = .pullRequest(""); state.query = "" }
                                Button(NewBranchStart.issue("").menuTitle) { state.form.start = .issue(""); state.query = "" }
                            }
                            .menuStyle(.borderlessButton).fixedSize().foregroundStyle(Theme.muted)
                        }
                        picker
                    }
                }
                if let e = state.error { ProblemLine(text: e) }
                HStack {
                    Spacer()
                    if state.busy { ProgressView().controlSize(.small) }
                    Button(state.preset.buttonTitle) { state.create(model: model) }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                        .disabled(!state.form.canCreate || state.busy)
                }
            }
        }
        .onChange(of: state.form.start.picker) { _, _ in state.loadPicker(model: model) }
    }
}
