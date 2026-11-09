import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// What the sheet opens on after a workspace was made from a project row or the project menu.
struct NativeSheetPreset: Equatable {
    var projectId: String
    var workspaceId: String?
    var error: String?
}

extension NewChatState {
    /// Projects, models and (for the chosen project) its workspaces, for the Squeak chat form.
    func loadNative(model: AppModel, preselect: String?) {
        let keepText = native.text
        let preset = nativePreset
        nativePreset = nil
        native = NativeNewChatForm()
        native.text = keepText
        nativeError = nil
        nativeLoading = true
        Task { [weak self] in
            async let projects = model.nativeProjects()
            async let listed = model.newChatModels()
            let (list, models) = await (projects, listed)
            guard let self else { return }
            native.setModels(models)
            if let list { native.setProjects(list, select: preset?.projectId) }
            nativeLoading = false
            await loadNativeWorkspaces(model: model)
            if let preset {
                if let id = preset.workspaceId, native.workspaces.contains(where: { $0.id == id }) { native.place = .existing(id) }
                if let e = preset.error { nativeError = e }
            }
        }
    }

    func loadNativeWorkspaces(model: AppModel) async {
        guard let id = native.projectId else { return }
        let list = await model.nativeWorkspaces(projectId: id)
        if native.projectId == id { native.setWorkspaces(list) }
    }

    /// "New workspace in <project>" from the project menu: the same make-then-open as the sidebar's "+".
    func makeNativeWorkspace(model: AppModel) {
        guard let id = native.projectId else { return }
        model.nativeMakeWorkspace(projectId: id)
    }

    func addNativeFolder(model: AppModel) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Add folder"
        panel.message = "Pick a git repository folder to start Squeak chats in."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        nativeError = nil
        Task { [weak self] in
            let (project, problem) = await model.nativeAddProject(path: url.path)
            guard let self else { return }
            if let project, let all = await model.nativeProjects() { native.setProjects(all, select: project.id); await loadNativeWorkspaces(model: model) }
            else { nativeError = problem ?? "Squeak couldn't add that folder." }
        }
    }

    func startNative(model: AppModel, close: @escaping () -> Void) {
        guard !nativeStarting, let spec = native.request else { return }
        nativeStarting = true
        nativeError = nil
        Task { [weak self] in
            let (key, problem) = await model.startNativeChat(spec)
            guard let self else { return }
            nativeStarting = false
            if key != nil { native.text = ""; close() } else { nativeError = problem } // the words stay when nothing started
        }
    }
}

/// The New chat sheet for a chat Squeak runs itself (DESIGN.md §8.10, the d-new-chat mock).
struct NativeNewChatView: View {
    var close: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(NewChatState.self) private var state

    var body: some View {
        @Bindable var state = state
        let f = state.native
        let busy = state.nativeStarting
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("New chat").font(.system(size: Metrics.pageTitle, weight: .bold))
                Spacer()
                NCSegmented(
                    options: [("new", "New workspace"), ("existing", "Existing workspace"), ("folder", "Project folder")],
                    selection: whereTag(f.place)) { pick in
                    switch pick {
                    case "new": state.native.place = .newWorkspace
                    case "existing": if let w = state.native.workspaces.first { state.native.place = .existing(w.id) }
                    default: state.native.place = .projectFolder
                    }
                }
                .frame(maxWidth: 380)
            }
            .padding(.horizontal, 24).padding(.top, 24).padding(.bottom, 18)
            // The form's own height when it fits; it scrolls only when the window is shorter.
            ViewThatFits(in: .vertical) {
                formBody(f, busy: busy)
                ScrollView { formBody(f, busy: busy) }.scrollBounceBehavior(.basedOnSize)
            }
            footer.padding(.horizontal, 24).padding(.bottom, 18)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func formBody(_ f: NativeNewChatForm, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if state.nativeLoading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading projects…").foregroundStyle(Theme.muted) }
                    .frame(maxWidth: .infinity, minHeight: 160)
            } else {
                fields(f).disabled(busy)
            }
        }
        .padding(.horizontal, 24).padding(.bottom, 20)
    }

    /// The first-message editor grows with its lines, 96 to 220.
    private var messageHeight: CGFloat {
        let lines = state.native.text.split(separator: "\n", omittingEmptySubsequences: false).reduce(0) { $0 + max(1, $1.count / 70 + 1) }
        return min(220, max(96, CGFloat(lines) * 20 + 28))
    }

    private func whereTag(_ p: NativeWhere) -> String {
        switch p { case .newWorkspace: "new"; case .existing: "existing"; case .projectFolder: "folder" }
    }

    @ViewBuilder private func fields(_ f: NativeNewChatForm) -> some View {
        @Bindable var state = state
        column("Project") {
            HStack(spacing: 8) {
                if f.projects.isEmpty {
                    Text("No projects yet. Add a folder to start.").font(Typo.body).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: Metrics.field, alignment: .leading)
                } else {
                    NCPopup(label: "Project", selection: Binding(get: { state.native.projectId ?? "" }, set: { id in
                        state.native.choose(project: id)
                        Task { await state.loadNativeWorkspaces(model: model) }
                    }), options: f.projects.map { ($0.id, $0.name) },
                    extraItem: (title: f.project.map { "New workspace in \($0.name)" } ?? "New workspace", action: { state.makeNativeWorkspace(model: model) }))
                }
                Button("Add folder…") { state.addNativeFolder(model: model) }.buttonStyle(SecondaryButtonStyle())
            }
        }
        switch f.place {
        case .newWorkspace:
            hint("Creates a git worktree with a bird's name, branched from \(f.project?.defaultBranch ?? "the default branch").", glyph: .gitBranch)
        case .existing(let id):
            column("Workspace") {
                NCPopup(label: "Workspace", selection: Binding(get: { id }, set: { state.native.place = .existing($0) }),
                        options: f.workspaces.map { ($0.id, $0.name == $0.branch ? $0.name : "\($0.name) · \($0.branch)") })
            }
        case .projectFolder:
            hint(f.project?.rootPath ?? "", glyph: .folder)
        }
        HStack(alignment: .top, spacing: 12) {
            column("Agent") {
                NCSegmented(options: NewChatAgent.allCases.map { ($0.rawValue, $0.displayName) }, selection: f.agent.rawValue,
                            mark: { NewChatAgent(rawValue: $0)?.mark }) { state.native.choose(agent: NewChatAgent(rawValue: $0) ?? .claude) }
            }
            column("Permissions") {
                NCPopup(label: "Permissions", selection: Binding(get: { state.native.mode }, set: { state.native.mode = $0 }),
                        options: NativeModes.menu.map { ($0, $0.word) })
            }
        }
        if f.mode == .skipApprovals {
            Text(NativeModes.skipWarning).font(Typo.meta).foregroundStyle(Theme.negative)
        }
        if f.agentModels.isEmpty {
            Text("Squeak's service lists no models yet, so a chat can't start. Check Settings.").font(Typo.meta).foregroundStyle(Theme.muted)
        } else {
            HStack(alignment: .top, spacing: 12) {
                column("Model") {
                    NCPopup(label: "Model", selection: Binding(get: { state.native.modelId ?? "" }, set: { state.native.pick(modelId: $0) }),
                            options: f.agentModels.map { ($0.id, ChatPresets.shortName($0.label) + ($0.label.contains("1M") ? " · 1M" : "")) })
                }
                column("Effort") {
                    if let m = f.chosenModel, !m.levels.isEmpty {
                        NCPopup(label: "Effort", selection: Binding(get: { state.native.effort ?? "" }, set: { state.native.pick(effort: $0) }),
                                options: m.levels.map { ($0, DaemonChatModel.levelName($0)) })
                    } else {
                        Text("Not adjustable").font(Typo.body).foregroundStyle(Theme.subtle).frame(maxWidth: .infinity, minHeight: Metrics.field, alignment: .leading)
                    }
                }
            }
        }
        column("First message") {
            ComposerField(
                text: $state.native.text, sendKey: .commandReturnSends, placeholder: "What should it work on?",
                isEnabled: !state.nativeStarting, focusToken: state.focus, onSend: start, onEscape: close)
                .frame(height: messageHeight)
                .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: Radius.card))
                .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            if state.native.trimmedText.count > NewChatForm.maxLength {
                Text("That's over \(NewChatForm.maxLength.formatted()) characters. Shorten it to start.").font(Typo.meta).foregroundStyle(Theme.negative)
            }
        }
    }

    private func column<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12)).foregroundStyle(Theme.muted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hint(_ text: String, glyph: LucideName) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Lucide(glyph, size: 13, color: Theme.muted)
            Text(verbatim: text).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let e = state.nativeError {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.triangleAlert, size: Metrics.icon, color: Theme.negative)
                    Text(e).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
                ReportProblemButton(problem: e, place: "New chat")
            }
            NCHairline().padding(.horizontal, -6)
            HStack(spacing: 12) {
                if state.nativeStarting { ProgressView().controlSize(.small); Text("Starting…").font(Typo.meta).foregroundStyle(Theme.muted) }
                else { Button("New chat in Conductor…") { state.useConductor = true }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                Spacer()
                Button("Cancel") { close() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button(state.native.startLabel) { start() }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!state.native.canStart || state.nativeStarting)
            }
            .padding(.top, 4)
        }
    }

    private func start() { state.startNative(model: model, close: close) }
}
