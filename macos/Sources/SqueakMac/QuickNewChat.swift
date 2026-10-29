import SqueakIcons
import SqueakMacCore
import SwiftUI

/// A compose page within the floating quick panel. Its form owns no desktop or popup navigation.
struct QuickNewChatView: View {
    var back: () -> Void
    var complete: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(NewChatState.self) private var state
    @Environment(QuickState.self) private var quick
    private var choosingWorkspace: Bool { quick.choosingNewChatWorkspace }
    @FocusState private var searchFocused: Bool

    private var busy: Bool { state.phase == .starting }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Button(action: goBack) {
                    Lucide(.chevronLeft, size: 17, color: Theme.ink).frame(width: 30, height: 30)
                        .background(Theme.surfaceRaised.opacity(0.6), in: Circle())
                }
                .buttonStyle(.plain).accessibilityLabel(choosingWorkspace ? "Back to new chat" : "Back to quick message")
                Text(choosingWorkspace ? "Choose workspace" : "New chat").font(.system(size: 17, weight: .semibold))
                Spacer()
                Text("Quick message").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            NCHairline()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch state.phase {
                    case .loading:
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading workspaces…") }
                            .font(.system(size: 13)).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity, minHeight: 150)
                    case .offline:
                        notice("Squeak can't reach its service. Try again when it reconnects.")
                        Button("Try again") { state.prepare(model: model, preselect: state.form.workspaceId) }
                            .buttonStyle(SecondaryButtonStyle())
                    case .outdated:
                        notice("Update the Squeak service in Settings to start chats.")
                    case .ready, .starting:
                        if choosingWorkspace { workspacePicker } else { form }
                    }
                }
                .padding(20)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            NCHairline()
            footer.padding(.horizontal, 20).padding(.vertical, 14)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .modifier(GlassPanel(radius: 26))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 14)
        .onExitCommand(perform: goBack)
    }

    private func notice(_ text: String) -> some View {
        Text(text).font(.system(size: 14)).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
    }

    @ViewBuilder private var form: some View {
        @Bindable var state = state
        let f = state.form
        HStack {
            label("Workspace")
            Spacer()
            if state.makingWorkspace {
                ProgressView().controlSize(.small)
                Text("Making workspace…").font(.system(size: 12)).foregroundStyle(Theme.muted)
            } else if let repos = model.workspaceRepos, !repos.isEmpty {
                Menu("New workspace") {
                    ForEach(repos) { repo in
                        Button(repo.name) { state.createWorkspace(model: model, repoId: repo.id) }
                    }
                }
                .font(.system(size: 12)).menuStyle(.borderlessButton).fixedSize().disabled(busy)
            }
        }
        .task { if model.workspaceRepos == nil { await model.loadWorkspaceRepos() } }
        Button {
            quick.choosingNewChatWorkspace = true
        } label: {
            HStack(spacing: 10) {
                Lucide(.layers, size: 16, color: Theme.muted)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: f.selected?.label ?? "Choose a workspace").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.ink)
                    if let title = f.selected?.title { Text(verbatim: title).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                }.lineLimit(1)
                Spacer(minLength: 8)
                Lucide(.chevronDown, size: 14, color: Theme.muted)
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surfaceRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(busy || state.makingWorkspace)
        setup.disabled(busy)
        HStack {
            label("First message")
            Spacer()
            if f.selected?.path != nil { AttachButton(tray: state.images, size: 22).disabled(busy) }
        }
        ImageStrip(tray: state.images)
        ComposerField(text: $state.form.text, sendKey: .commandReturnSends, placeholder: "What should it work on?",
                      isEnabled: !busy, focusToken: state.focus, onSend: start, onEscape: goBack, fontSize: 15,
                      onImages: busy || f.selected?.path == nil ? nil : { state.images.add($0) })
            .padding(.horizontal, 6).frame(height: 86)
            .background(Theme.surfaceRaised.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.line))
            .imageDrop(state.images)
        if f.isTooLong {
            Text("That's over \(NewChatForm.maxLength.formatted()) characters. Shorten it to start.")
                .font(.system(size: 12)).foregroundStyle(Theme.error)
        }
    }

    @ViewBuilder private var setup: some View {
        @Bindable var state = state
        let f = state.form
        VStack(alignment: .leading, spacing: 10) {
            if !f.presets.isEmpty {
                HStack(spacing: 8) {
                    ForEach(f.presets + (f.preset == .custom ? [.custom] : []), id: \.self) { preset in
                        Button { if preset != .custom { state.form.apply(preset: preset) } } label: {
                            Text(preset.title).font(.system(size: 13, weight: preset == f.preset ? .semibold : .regular))
                                .foregroundStyle(preset == f.preset ? Theme.ink : Theme.muted)
                                .frame(maxWidth: .infinity).padding(.vertical, 8)
                                .background(preset == f.preset ? Theme.selected : Theme.surfaceRaised.opacity(0.3), in: Capsule())
                                .overlay(Capsule().strokeBorder(Theme.line))
                        }
                        .buttonStyle(.plain).accessibilityAddTraits(preset == f.preset ? .isSelected : [])
                    }
                }
            }
            if !f.models.isEmpty { Text(f.summary).font(.system(size: 12)).foregroundStyle(Theme.muted) }
            DisclosureGroup("Customize", isExpanded: $state.customizing) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 12) {
                        column("Agent") {
                            NCPopup(label: "Agent", selection: Binding(get: { f.agent }, set: { state.form.choose(agent: $0) }),
                                    options: NewChatAgent.allCases.map { ($0, $0.displayName) })
                        }
                        if !f.agentModels.isEmpty {
                            column("Model") {
                                NCPopup(label: "Model", selection: Binding(get: { f.setup.modelId ?? "" }, set: { state.form.pick(modelId: $0) }),
                                        options: f.agentModels.map { ($0.id, ChatPresets.shortName($0.label)) })
                            }
                        }
                    }
                    if let chosen = f.chosenModel, !chosen.levels.isEmpty {
                        column("Thinking level") {
                            NCSegmented(options: chosen.levels.map { ($0, DaemonChatModel.levelName($0)) }, selection: f.setup.level ?? "") { state.form.pick(level: $0) }
                        }
                    }
                    if f.canSplit {
                        NCHairline()
                        label("Split the work")
                        HStack(alignment: .top, spacing: 12) {
                            column("Writes the code") { worker(f.setup.code, "Writes the code") { state.form.pick(code: $0) } }
                            column("Runs tests and builds") { worker(f.setup.run, "Runs tests and builds") { state.form.pick(run: $0) } }
                        }
                        Text("The chat's model plans and reviews; cheaper ones do the typing.")
                            .font(.system(size: 12)).foregroundStyle(Theme.muted)
                        Toggle("Plan first", isOn: Binding(get: { f.setup.planFirst }, set: { state.form.set(planFirst: $0) })).toggleStyle(.switch)
                    }
                }.padding(.top, 12)
            }
            .font(.system(size: 13)).tint(Theme.muted)
        }
    }

    @ViewBuilder private var workspacePicker: some View {
        @Bindable var state = state
        HStack(spacing: 8) {
            Lucide(.search, size: 14, color: Theme.muted)
            TextField("Search workspaces", text: $state.form.query).textFieldStyle(.plain).focused($searchFocused)
                .onAppear { searchFocused = true }
        }
        .padding(10).background(Theme.surfaceRaised.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        if state.form.filtered.isEmpty {
            notice(state.form.workspaces.isEmpty ? "No open workspaces in Conductor." : "No workspace matches.")
        }
        ForEach(state.form.filtered) { workspace in
            Button {
                state.form.select(workspace.id)
                quick.choosingNewChatWorkspace = false
                state.form.query = ""
                state.focus += 1
            } label: {
                HStack(spacing: 10) {
                    Lucide(workspace.id == state.form.workspaceId ? .check : .layers, size: 15, color: Theme.muted)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: workspace.label).font(.system(size: 14)).foregroundStyle(Theme.ink)
                        if let title = workspace.title { Text(verbatim: title).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                    }.lineLimit(1)
                    Spacer(minLength: 8)
                    RelativeTimeText(workspace.lastActivityAt).font(.system(size: 11)).foregroundStyle(Theme.muted)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(workspace.id == state.form.workspaceId ? Theme.selected : Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(busy)
            .accessibilityAddTraits(workspace.id == state.form.workspaceId ? .isSelected : [])
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = state.error { Text(error).font(.system(size: 12)).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true) }
            HStack(spacing: 10) {
                if busy {
                    ProgressView().controlSize(.small)
                    Text("Starting…").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 4)
                Button("Cancel", action: back).buttonStyle(SecondaryButtonStyle())
                if !choosingWorkspace {
                    Button("Start chat", action: start).buttonStyle(PrimaryButtonStyle())
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!state.form.canStart || state.phase != .ready || !model.isConnected || state.makingWorkspace)
                }
            }
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
    }

    private func column<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) { label(title); content() }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func worker(_ value: String?, _ title: String, select: @escaping (String?) -> Void) -> some View {
        NCPopup(label: title, selection: Binding(get: { value ?? "" }, set: { select($0.isEmpty ? nil : $0) }),
                options: [("", "Same model")] + ChatWorker.all.map { ($0.id, $0.label) })
    }

    private func goBack() {
        if choosingWorkspace { quick.choosingNewChatWorkspace = false; state.focus += 1 } else { back() }
    }

    private func start() {
        guard model.isConnected, !state.makingWorkspace else { return }
        state.start(model: model, openInWindow: false, close: complete)
    }
}
