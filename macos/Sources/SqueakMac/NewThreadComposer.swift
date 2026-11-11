import SqueakIcons
import SqueakMacCore
import SwiftUI

/// New thread's state, shared by the desktop page, the quick panel and the menu-bar popup (each owns its own).
@MainActor @Observable
final class NewThreadState {
    var form = NativeNewChatForm()
    var projects: [NativeProject] = []
    /// Live branches of every pond, for the compact "pond › branch" picker.
    var branches: [NativeWorkspace] = []
    var place: NativeWorkspace?
    /// Set when the thread starts in a Conductor workspace (its ticked workspace) rather than a Squeak branch.
    var conductorWorkspace: NewChatWorkspace?
    /// A named place shows as plain text; none named gets the compact picker.
    var fixedPlace = false
    var loading = true
    var starting = false
    var error: String?
    var focus = 0
    /// Split the work (Claude only): which models write code and run commands; nil is the thread's own model.
    var splitOn = false
    var splitCode: String? = "sonnet"
    var splitRun: String? = "haiku"
    let images = ImageTray()
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    var pondName: String? {
        if let c = conductorWorkspace { return c.repoName }
        return place.flatMap { p in projects.first { $0.id == p.projectId }?.name }
    }
    var branchName: String? {
        if let c = conductorWorkspace { return c.branch }
        return place?.displayTitle
    }
    var folder: String? { conductorWorkspace?.path ?? place?.path }
    var hasPlace: Bool { place != nil || conductorWorkspace != nil }

    var canStart: Bool {
        NewThreadRules.canStart(text: form.text, hasPlace: hasPlace, hasModel: form.modelId != nil, starting: starting,
                                connected: AppModel.shared.isConnected || AppModel.shared.demoMode)
    }

    func prepare(model: AppModel, route: NewPage = .thread(projectId: nil, workspaceId: nil), projectId: String? = nil,
                 workspaceId: String? = nil, text: String? = nil, error: String? = nil, conductorWorkspaceId: String? = nil) {
        loadTask?.cancel()
        form = NativeNewChatForm()
        form.text = text ?? ""
        splitOn = false
        self.error = error
        images.clear()
        place = nil
        conductorWorkspace = nil
        fixedPlace = conductorWorkspaceId != nil || (projectId != nil && workspaceId != nil)
        loading = true
        starting = false
        focus += 1
        loadTask = Task { [weak self] in
            let models = await model.newChatModels()
            guard let self, !Task.isCancelled else { return }
            form.setModels(models)
            if let conductorWorkspaceId {
                if case .success(let list) = await model.newChatWorkspaces(), let w = list.first(where: { $0.id == conductorWorkspaceId }) {
                    conductorWorkspace = w
                    form.choose(agent: w.defaultAgent)
                } else if self.error == nil { self.error = "That workspace isn't listed in Conductor any more." }
            } else {
                projects = await model.nativeProjects() ?? []
                if model.git.workspaces.isEmpty { await model.refreshNativeWorkspaces() }
                branches = model.git.workspaces.filter { $0.state != "archived" }
                let recent = model.sidebarTree.projects.flatMap(\.workspaces)
                    .sorted { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }
                    .compactMap { w in w.chats.first(where: { $0.source == .squeak })?.cwd }
                if let workspaceId, let w = branches.first(where: { $0.id == workspaceId }) { place = w }
                else if let projectId { place = QuickPlace.defaultWorkspace(recentCwds: recent, workspaces: branches.filter { $0.projectId == projectId }) }
                else { place = QuickPlace.defaultWorkspace(recentCwds: recent, workspaces: branches) }
                if place == nil, self.error == nil { self.error = "There is no stream to start a thread in yet. Make one from its pond." }
            }
            loading = false
            focus += 1
        }
    }

    func start(model: AppModel, openInWindow: Bool = true, done: @escaping () -> Void) {
        guard canStart, let modelId = form.modelId else { return }
        starting = true
        error = nil
        guard let text = images.prepareToSend(text: form.trimmedText, folder: folder) else { starting = false; return }
        let hadImages = images.hasImages
        Task { [weak self] in
            guard let self else { return }
            var problem: String?
            var started = false
            if let c = conductorWorkspace {
                let r = await model.startChat(workspaceId: c.id, agent: form.agent, text: text, model: modelId, thinking: form.effort,
                                              split: nil, openInWindow: openInWindow)
                switch r {
                case .started: started = true
                case .failed(let why), .uncertain(let why): problem = why
                }
            } else if let place {
                let spec = NativeNewSession(
                    agent: form.agent.rawValue, model: modelId, permissionMode: NativeModes.permissionMode(form.mode),
                    effort: form.effort, cwd: place.path, projectId: place.projectId, text: text,
                    split: NewThreadRules.split(agent: form.agent, on: splitOn, code: splitCode, run: splitRun))
                let (key, why) = await model.startNativeChat(spec)
                started = key != nil
                problem = why
            }
            starting = false
            if started {
                form.text = ""
                if hadImages { images.clear() }
                done()
            } else {
                error = problem // the words stay
            }
        }
    }
}

/// The one New thread component: a message box, the place above it ("pond › branch", or a compact picker when no
/// place was named), one chip row below (agent and model, Options, attach) and Start.
struct NewThreadComposer: View {
    var state: NewThreadState
    var compact = false
    var onEscape: () -> Void
    var onStarted: () -> Void
    var openInWindow = true
    @Environment(AppModel.self) private var model
    @State private var optionsOpen = false

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: compact ? 10 : 14) {
            placeLine
            if state.loading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading…").foregroundStyle(Theme.muted) }
                    .font(.system(size: 13)).frame(maxWidth: .infinity, minHeight: 90)
            } else {
                ImageStrip(tray: state.images)
                ComposerField(
                    text: $state.form.text, sendKey: .returnSends, placeholder: "What should it work on?",
                    isEnabled: !state.starting, focusToken: state.focus, onSend: start, onEscape: onEscape,
                    fontSize: compact ? 13 : 14, onImages: state.hasPlace ? { state.images.add($0) } : nil)
                    .padding(.horizontal, 6)
                    .frame(height: compact ? 96 : 150)
                    .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: Radius.card))
                    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
                    .imageDrop(state.images)
                if state.form.trimmedText.count > NewChatForm.maxLength {
                    Text("That's over \(NewChatForm.maxLength.formatted()) characters. Shorten it to start.")
                        .font(Typo.meta).foregroundStyle(Theme.negative)
                }
                chipRow
            }
            if let e = state.error {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.triangleAlert, size: Metrics.icon, color: Theme.negative)
                    Text(e).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
                ReportProblemButton(problem: e, place: "New thread")
                if model.addons.conductorLink?.isLinkProblem(e) == true {
                    Button("Open Conductor settings") { model.openSettings(.conductor) }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .disabled(state.starting)
    }

    // MARK: Place

    @ViewBuilder private var placeLine: some View {
        if state.fixedPlace || state.conductorWorkspace != nil {
            crumb(pond: state.pondName, branch: state.branchName)
        } else {
            SqueakMenu {
                ForEach(state.projects) { p in
                    let list = state.branches.filter { $0.projectId == p.id }
                    if !list.isEmpty {
                        Section(p.name) {
                            ForEach(list) { w in Button("\(p.name) › \(w.displayTitle)") { state.place = w; state.focus += 1 } }
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    crumb(pond: state.pondName, branch: state.branchName)
                    Lucide(.chevronDown, size: 12, color: Theme.muted)
                }
                .padding(.horizontal, 8).frame(height: 26)
                .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Pond and branch: \(state.pondName ?? "none") \(state.branchName ?? ""). Change.")
        }
    }

    private func crumb(pond: String?, branch: String?) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: pond ?? "No pond").foregroundStyle(Theme.muted)
            Text("›").foregroundStyle(Theme.subtle)
            Text(verbatim: branch ?? "no branch").foregroundStyle(Theme.ink)
        }
        .font(.system(size: 13)).lineLimit(1)
    }

    // MARK: Chips

    private var chipRow: some View {
        HStack(spacing: 8) {
            agentChip
            optionsChip
            if state.hasPlace { AttachButton(tray: state.images, size: 26) }
            Spacer(minLength: 4)
            if state.starting { ProgressView().controlSize(.small) }
            Text("↵ starts · ⇧↵ newline").font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                .opacity(compact ? 0 : 1).frame(maxWidth: compact ? 0 : nil)
            Button(NewThreadRules.startLabel) { start() }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(!state.canStart)
        }
    }

    private func chip<C: View>(_ label: String, mark: AgentMarkAsset? = nil, @ViewBuilder _ trailing: () -> C = { EmptyView() }) -> some View {
        HStack(spacing: 6) {
            if let mark { AgentMark(mark, size: 14) }
            Text(verbatim: label).font(.system(size: 12)).foregroundStyle(Theme.ink).lineLimit(1)
            Lucide(.chevronDown, size: 11, color: Theme.muted)
        }
        .padding(.horizontal, 9).frame(height: 26)
        .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .contentShape(Rectangle())
    }

    private var agentChip: some View {
        let f = state.form
        let name = f.chosenModel.map { ChatPresets.shortName($0.label) } ?? "Choose a model"
        return SqueakMenu {
            ForEach(NewChatAgent.allCases, id: \.self) { agent in
                Section(agent.displayName) {
                    ForEach(ChatPresets.models(f.models, agent)) { m in
                        Button(ChatPresets.shortName(m.label) + (m.label.contains("1M") ? " · 1M" : "")) {
                            state.form.choose(agent: agent)
                            state.form.pick(modelId: m.id)
                        }
                    }
                }
            }
        } label: { chip("\(f.agent.displayName) · \(name)", mark: f.agent.mark) {} }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("Agent and model: \(f.agent.displayName), \(name)")
    }

    private var optionsChip: some View {
        Button { optionsOpen.toggle() } label: { chip("Options") {} }
            .buttonStyle(.plain)
            .accessibilityLabel("Options")
            .popover(isPresented: $optionsOpen, arrowEdge: .top) { options.padding(14).frame(width: 300) }
    }

    /// Presets, thinking, plan first and (Claude only) Split the work.
    private var options: some View {
        @Bindable var state = state
        let f = state.form
        return VStack(alignment: .leading, spacing: 14) {
            if !f.presets.isEmpty {
                NCField("Preset") {
                    NCSegmented(options: f.presets.map { ($0.rawValue, $0.title) }, selection: f.activePreset.rawValue) { pick in
                        if let p = ChatPreset(rawValue: pick) { state.form.apply(preset: p) }
                    }
                }
            }
            if let m = f.chosenModel, !m.levels.isEmpty {
                NCField("Thinking") {
                    NCSegmented(options: m.levels.map { ($0, DaemonChatModel.levelName($0)) }, selection: f.effort ?? "") { state.form.pick(effort: $0) }
                }
            }
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Plan first").font(.system(size: 13, weight: .semibold))
                    Text("Shows you the plan and waits for your go.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                }
                Spacer()
                Toggle("Plan first", isOn: Binding(get: { state.form.planFirst }, set: { state.form.set(planFirst: $0) }))
                    .labelsHidden().toggleStyle(.switch)
            }
            if NewThreadRules.offersSplit(agent: f.agent) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Split the work").font(.system(size: 13, weight: .semibold))
                        Text("This model plans; cheaper models write code and run commands.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Toggle("Split the work", isOn: $state.splitOn).labelsHidden().toggleStyle(.switch)
                }
                if state.splitOn {
                    workerPicker("Code", selection: $state.splitCode)
                    workerPicker("Run commands", selection: $state.splitRun)
                }
            }
        }
    }

    private func workerPicker(_ title: String, selection: Binding<String?>) -> some View {
        NCField(title) {
            NCSegmented(options: [("", "Same model")] + ChatWorker.all.map { ($0.id, $0.label) }, selection: selection.wrappedValue ?? "") {
                selection.wrappedValue = $0.isEmpty ? nil : $0
            }
        }
    }

    private func start() { state.start(model: model, openInWindow: openInWindow, done: onStarted) }
}

/// New thread on the desktop: the title, then the component, centred.
struct NewThreadPage: View {
    var state: NewThreadState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                Text("New thread").font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                NewThreadComposer(state: state, onEscape: { NewChatController.shared.hide() }, onStarted: { NewChatController.shared.hide() })
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, Space.xl).padding(.top, Space.l).padding(.bottom, Space.xl)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

/// The quick panel's page: a back arrow, then the component with its compact picker.
struct QuickNewThreadView: View {
    var back: () -> Void
    var complete: () -> Void
    var state: NewThreadState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Button(action: back) {
                    Lucide(.chevronLeft, size: 17, color: Theme.ink).frame(width: 30, height: 30)
                        .background(Theme.surfaceRaised.opacity(0.6), in: Circle())
                }
                .buttonStyle(.plain).accessibilityLabel("Back to quick message")
                Text("New thread").font(.system(size: 17, weight: .semibold))
                Spacer()
                Text("Quick message").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            NCHairline()
            ScrollView {
                NewThreadComposer(state: state, compact: true, onEscape: back, onStarted: complete, openInWindow: false).padding(20)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .modifier(GlassPanel(radius: 26))
        .shadow(color: .black.opacity(0.35), radius: 24, y: 14)
        .onExitCommand(perform: back)
    }
}

/// The menu-bar popup's New thread: top bar and band (no footer; Start sits in the chip row).
struct PopupNewThreadTop: View {
    var body: some View {
        HStack(spacing: 14) {
            PopupBackButton { PopupNav.shared.back() }
            Text("New thread").font(.popup(15, .semibold)).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
        }
        .padding(.top, 14).padding(.bottom, 10)
    }
}

struct PopupNewThreadBand: View {
    let state = PopupNav.shared.newChat

    var body: some View {
        NewThreadComposer(state: state, compact: true, onEscape: { PopupNav.shared.back() },
                          onStarted: { PopupNav.shared.show(.home) }, openInWindow: false)
            .padding(.vertical, 12)
    }
}
