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
    var form = NewPondForm()
    var busy = false
    var error: String?
    var waiting = false

    func reset() { form = NewPondForm(); busy = false; error = nil; waiting = false }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "Choose a git repository. It becomes a pond."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        form.chooseFolder(url.path)
    }

    func create(model: AppModel) {
        guard form.canCreate, !busy else { return }
        busy = true
        error = nil
        let f = form
        Task { [weak self] in
            guard let self else { return }
            defer { busy = false }
            switch f.kind {
            case .folder:
                let (project, problem) = await ProjectActions.shared.add(model, path: f.folderPath ?? "")
                finish(model, project, problem)
            case .clone:
                let (project, problem) = await ProjectActions.shared.clone(model, url: f.cloneURL.trimmingCharacters(in: .whitespacesAndNewlines))
                finish(model, project, problem)
            case .invite:
                let ponds = PondsModel.shared
                let name = f.name.trimmingCharacters(in: .whitespaces)
                guard let code = PondInviteText.cleaned(f.inviteCode),
                      let r = await ponds.join(code: code, name: name.isEmpty ? NSFullUserName() : name) else {
                    error = PondsModel.shared.note ?? "That invite didn\u{2019}t work."
                    return
                }
                if r.isPending { waiting = true } else {
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
                NCField(state.form.kind == .invite ? "Your name" : "Name") {
                    TextField(state.form.kind == .invite ? NSFullUserName() : "Pond name",
                              text: Binding(get: { state.form.name }, set: { state.form.setName($0) }))
                        .textFieldStyle(.roundedBorder).accessibilityLabel("Name")
                }
                VStack(spacing: Space.s) {
                    choice(.folder, icon: .folder) {
                        HStack(spacing: 8) {
                            Button("Choose folder\u{2026}") { state.chooseFolder() }.buttonStyle(SecondaryButtonStyle())
                            if let p = state.form.folderPath {
                                Text(verbatim: p).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                            }
                        }
                    }
                    choice(.clone, icon: .gitBranch) {
                        TextField("owner/repo or a git URL", text: $state.form.cloneURL).textFieldStyle(.roundedBorder)
                            .onSubmit { state.create(model: model) }.accessibilityLabel("Repository to clone")
                    }
                    choice(.invite, icon: .users) {
                        TextField("Paste the invite code", text: $state.form.inviteCode).textFieldStyle(.roundedBorder).font(Typo.code)
                            .onSubmit { state.create(model: model) }.accessibilityLabel("Invite code")
                    }
                }
                if state.waiting {
                    Text("Waiting for the owner to approve. The pond appears in the sidebar once you\u{2019}re approved.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                }
                if let e = state.error { ProblemLine(text: e) }
                HStack {
                    Spacer()
                    if state.busy { ProgressView().controlSize(.small) }
                    Button(state.form.buttonTitle) { state.create(model: model) }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
                        .disabled(!state.form.canCreate || state.busy)
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
    var form = NewBranchForm(defaultBranch: "main", taken: [])
    var suggested = ""
    var preset: NewBranchPreset = .newFromDefault
    var busy = false
    var error: String?

    func prepare(model: AppModel, projectId: String, preset: NewBranchPreset = .newFromDefault) {
        self.preset = preset
        busy = false
        error = nil
        let p = model.native.projects.first { $0.id == projectId }
        project = p
        let taken = model.git.workspaces.filter { $0.projectId == projectId }.map(\.name)
        form = NewBranchForm(defaultBranch: p?.defaultBranch ?? "main", taken: taken, preset: preset)
        suggested = form.name
        if p == nil {
            Task { [weak self] in
                guard let self, let list = await model.nativeProjects(), let found = list.first(where: { $0.id == projectId }) else { return }
                project = found
                form = NewBranchForm(defaultBranch: found.defaultBranch, taken: taken, preset: preset)
                suggested = form.name
            }
        }
    }

    func create(model: AppModel) {
        guard let project, form.canCreate, !busy else { return }
        if model.demoMode { error = "Demo data: no branch is made."; return }
        busy = true
        error = nil
        let source = form.start.source
        Task { [weak self] in
            guard let self else { return }
            do {
                let made: NativeWorkspace
                var prompt: String?
                if let source {
                    let m = try await model.nativeHost.createWorkspace(projectId: project.id, from: source)
                    made = m.workspace
                    prompt = m.prompt
                } else {
                    made = try await model.nativeHost.createWorkspace(projectId: project.id)
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

    private var startInput: some View {
        TextField(state.form.start.placeholder,
                  text: Binding(get: { state.form.start.input }, set: { state.form.start = state.form.start.with(input: $0) }))
            .textFieldStyle(.roundedBorder).onSubmit { state.create(model: model) }
            .accessibilityLabel(state.form.start.menuTitle)
    }

    var body: some View {
        @Bindable var state = state
        NewPageFrame(title: state.preset.title) {
            VStack(alignment: .leading, spacing: Space.l) {
                Text(verbatim: state.project?.name ?? "No pond").font(Typo.label).foregroundStyle(Theme.muted)
                if state.form.showsName {
                    NCField("Branch name") {
                        TextField("Branch name", text: $state.form.name).textFieldStyle(.roundedBorder)
                            .onSubmit { state.create(model: model) }.accessibilityLabel("Branch name")
                        if state.form.nameIsIgnored(suggested: state.suggested) {
                            Text("Squeak names the branch itself for now.").font(Typo.meta).foregroundStyle(Theme.muted)
                        }
                    }
                }
                if state.preset.namesItself {
                    startInput
                } else {
                    NCField("Start from") {
                        HStack(spacing: 10) {
                            Text(verbatim: state.form.startLabel).font(Typo.body).foregroundStyle(Theme.ink)
                            Menu("Start from\u{2026}") {
                                Button(NewBranchStart.defaultBranch.menuTitle) { state.form.start = .defaultBranch }
                                Button(NewBranchStart.branch("").menuTitle) { state.form.start = .branch("") }
                                Button(NewBranchStart.pullRequest("").menuTitle) { state.form.start = .pullRequest("") }
                                Button(NewBranchStart.issue("").menuTitle) { state.form.start = .issue("") }
                            }
                            .menuStyle(.borderlessButton).fixedSize().foregroundStyle(Theme.muted)
                        }
                        if state.form.start != .defaultBranch { startInput }
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
    }
}
