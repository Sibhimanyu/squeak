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
    /// Set when a pond's Start a thread opened the page: the thread starts through the pond's route and is shared.
    var pond: PondThreadContext?
    /// The pond project's streams, newest first, for the pond picker.
    var streamOptions: [NativeWorkspace] = []
    /// The pond's own folder (Main) when it has one (a git pond): where a thread starts by default.
    var main: MainPlace?
    /// "In:" outside a pond's Start a thread (⌘N): Main, an existing stream (`place`) or a new one. Inside it, `pond.choice`.
    @ObservationIgnored private var ownChoice: StartThreadStream = .new
    var choice: StartThreadStream {
        get { pond?.choice ?? ownChoice }
        set { if pond != nil { pond?.choice = newValue } else { ownChoice = newValue } }
    }
    /// The busy-Main offer's answer so far ("Stay in Main" hides it until the page is opened again).
    var offer = NewChatIn.Offer()
    /// The chat holding Main right now, while the choice is Main.
    var busyMain: HostSession? { main.flatMap { AppModel.shared.busyMainChat($0) } }
    var showsBusyOffer: Bool { offer.shows(choice: choice, busy: busyMain) }
    var startsInMain: Bool { main != nil && choice == .main }
    /// A new stream is chosen: the host makes it when the thread starts.
    var newStream: Bool { (pond != nil || main != nil) && place == nil && choice == .new }

    /// Picks where the thread starts; a stream sets `place`, Main and a new stream clear it.
    func choose(_ c: StartThreadStream) {
        choice = c
        place = c.workspaceId.flatMap { id in streamOptions.first { $0.id == id } }
        offer = NewChatIn.Offer()
        focus += 1
    }

    /// The pond ⌘N means: the open chat's, else the one on screen, else the one with the newest chat.
    private static func contextProject(model: AppModel, projects: [NativeProject]) -> NativeProject? {
        let ponds = PondsModel.shared
        let key = model.selected.flatMap { k in model.allSessions.first { $0.key == k } }.flatMap { ponds.key(of: $0) }
            ?? ponds.homeProject
            ?? ponds.directory?.ponds.first { !$0.hidden && $0.projectId != nil }?.id
        return key.flatMap { k in ponds.entry(k)?.projectId }.flatMap { id in projects.first { $0.id == id } }
    }
    /// Split the work (Claude only): which models write code and run commands; nil is the thread's own model.
    /// They live in the form so a preset sets them with the model and level.
    var splitOn: Bool { get { form.splitOn } set { form.splitOn = newValue } }
    var splitCode: String? { get { form.splitCode } set { form.splitCode = newValue } }
    var splitRun: String? { get { form.splitRun } set { form.splitRun = newValue } }
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
    var folder: String? { conductorWorkspace?.path ?? (startsInMain ? main?.rootPath : nil) ?? place?.path }
    var hasPlace: Bool { place != nil || conductorWorkspace != nil || startsInMain }

    /// The thread runs on the pond owner's Mac (a signed request): there is no place on this Mac to name.
    var runsOnOwner: Bool { pond?.runsOnOwner == true }

    var canStart: Bool {
        NewThreadRules.canStart(text: form.text, hasPlace: hasPlace || newStream || runsOnOwner, hasModel: form.modelId != nil, starting: starting,
                                connected: AppModel.shared.isConnected || AppModel.shared.demoMode)
    }

    func prepare(model: AppModel, route: NewPage = .thread(projectId: nil, workspaceId: nil), projectId: String? = nil,
                 workspaceId: String? = nil, text: String? = nil, error: String? = nil, conductorWorkspaceId: String? = nil,
                 pond: PondThreadContext? = nil, contextPond: Bool = false) {
        loadTask?.cancel()
        self.pond = pond
        main = nil
        ownChoice = .new
        offer = NewChatIn.Offer()
        streamOptions = []
        form = NativeNewChatForm()
        form.text = text ?? ""
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
            _ = await model.syncChatPresets()
            form.setModels(models)
            form.loadPresets(ChatPresetPreferences())
            if let conductorWorkspaceId {
                if case .success(let list) = await model.newChatWorkspaces(), let w = list.first(where: { $0.id == conductorWorkspaceId }) {
                    conductorWorkspace = w
                    form.choose(agent: w.defaultAgent)
                } else if self.error == nil { self.error = "That workspace isn't listed in Conductor any more." }
            } else {
                projects = await model.nativeProjects() ?? []
                let wasEmpty = model.git.workspaces.isEmpty
                if wasEmpty { await model.refreshNativeWorkspaces() }
                branches = model.git.workspaces.filter { $0.state != "archived" }
                let recent = model.sidebarTree.projects.flatMap(\.workspaces)
                    .sorted { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }
                    .compactMap { w in w.chats.first(where: { $0.source == .squeak })?.cwd }
                // Main: a git pond's own folder. A named stream stays that stream; a pond's thread, a pond's "+" and ⌘N
                // inside a pond begin in Main.
                let mainProject: NativeProject? = pond.flatMap { p in projects.first { $0.id == p.projectId } }
                    ?? (workspaceId == nil ? (projectId.flatMap { id in projects.first { $0.id == id } } ?? (contextPond ? Self.contextProject(model: model, projects: projects) : nil)) : nil)
                main = workspaceId == nil ? mainProject.flatMap { MainPlace(project: $0) } : nil
                if var pond {
                    let recentByPath = Dictionary(model.sidebarTree.projects.flatMap(\.workspaces).compactMap { w in
                        w.chats.first(where: { $0.source == .squeak })?.cwd.flatMap { c in w.lastActivityAt.map { (c, $0) } }
                    }, uniquingKeysWith: max)
                    let active = Dictionary(uniqueKeysWithValues: branches.compactMap { w in recentByPath[w.path].map { (w.id, $0) } })
                    streamOptions = StartThreadStreams.options(branches, projectId: pond.projectId, lastActive: active)
                    pond.choice = StartThreadStreams.valid(pond.choice, in: streamOptions)
                    if pond.choice == .new, wasEmpty { pond.choice = NewChatIn.defaultChoice(hasMain: main != nil, requestedStream: nil, newestStream: streamOptions.first?.id) }
                    if main == nil, pond.choice == .main { pond.choice = StartThreadStreams.defaultChoice(streamOptions) }
                    self.pond = pond
                    place = pond.choice.workspaceId.flatMap { id in streamOptions.first { $0.id == id } }
                }
                else if let main {
                    // ⌘N (or a pond's "+"): Main, with the pond's streams one pick away.
                    let recentByPath = Dictionary(model.sidebarTree.projects.flatMap(\.workspaces).compactMap { w in
                        w.chats.first(where: { $0.source == .squeak })?.cwd.flatMap { c in w.lastActivityAt.map { (c, $0) } }
                    }, uniquingKeysWith: max)
                    let active = Dictionary(uniqueKeysWithValues: branches.compactMap { w in recentByPath[w.path].map { (w.id, $0) } })
                    streamOptions = StartThreadStreams.options(branches, projectId: main.projectId, lastActive: active)
                    ownChoice = .main
                    place = nil
                }
                else if let workspaceId, let w = branches.first(where: { $0.id == workspaceId }) { place = w }
                else if let projectId { place = QuickPlace.defaultWorkspace(recentCwds: recent, workspaces: branches.filter { $0.projectId == projectId }) }
                else { place = QuickPlace.defaultWorkspace(recentCwds: recent, workspaces: branches) }
                if place == nil, pond == nil, main == nil, self.error == nil { self.error = "There is no stream to start a thread in yet. Make one from its pond." }
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
                                              split: NewThreadRules.split(agent: form.agent, on: splitOn, code: splitCode, run: splitRun,
                                                                          planFirst: form.planFirst),
                                              openInWindow: openInWindow)
                switch r {
                case .started: started = true
                case .failed(let why), .uncertain(let why): problem = why
                }
            } else if let pond, pond.runsOnOwner {
                // The owner's Mac makes the chat (in the pond's folder, asking first) and the thread opens here when it appears.
                let ponds = PondsModel.shared
                if let summary = ponds.ponds.first(where: { $0.id == pond.pondId }) {
                    started = await ponds.requestStart(pond: summary, text: text, agent: form.agent.rawValue, model: modelId)
                }
                problem = started ? nil : (ponds.note ?? "That didn\u{2019}t go through")
            } else if let pond {
                let ponds = PondsModel.shared
                started = await ponds.startThread(pond: pond.pondId, text: text, agent: form.agent.rawValue, model: modelId,
                                                  workspaceId: place?.id, effort: form.effort,
                                                  permissionMode: NativeModes.permissionMode(form.mode),
                                                  split: NewThreadRules.split(agent: form.agent, on: splitOn, code: splitCode, run: splitRun),
                                                  isPrivate: pond.isPrivate, main: startsInMain)
                problem = started ? nil : (ponds.note ?? "That didn\u{2019}t go through")
            } else if let main, startsInMain || newStream {
                // Main runs in the pond's own folder (no stream); "New stream" asks the host for one.
                let spec = NativeNewSession(
                    agent: form.agent.rawValue, model: modelId, permissionMode: NativeModes.permissionMode(form.mode),
                    effort: form.effort, projectId: main.projectId, newWorkspace: !startsInMain, text: text,
                    split: NewThreadRules.split(agent: form.agent, on: splitOn, code: splitCode, run: splitRun), main: startsInMain)
                let (key, why) = await model.startNativeChat(spec)
                started = key != nil
                problem = why
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
                if state.pond != nil { shareRow }
                chipRow
            }
            if let e = state.error {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.triangleAlert, size: Metrics.icon, color: Theme.negative)
                    Text(e).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
                ReportProblemButton(problem: e, place: "New thread")
                if model.addons.conductorLink?.isLinkProblem(e) == true {
                    Button("Open Extensions settings") { model.openSettings(.addons) }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .disabled(state.starting)
    }

    // MARK: Place

    @ViewBuilder private var placeLine: some View {
        if let main = state.main, state.conductorWorkspace == nil, !state.fixedPlace {
            VStack(alignment: .leading, spacing: 8) {
                inLine(main)
                if state.showsBusyOffer, let busy = state.busyMain { busyOffer(busy) }
            }
        } else if let pond = state.pond {
            pondPlaceLine(pond)
        } else if state.fixedPlace || state.conductorWorkspace != nil {
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

    /// "pond › In: Main · branch ▾": where this unsent thread starts. Main (the pond's own folder) first, then the
    /// pond's streams newest first, then New stream.
    private func inLine(_ main: MainPlace) -> some View {
        let label = NewChatIn.label(state.choice, main: main, streams: state.streamOptions)
        return HStack(spacing: 8) {
            Text(verbatim: main.pondName).foregroundStyle(Theme.muted).lineLimit(1)
            Text("\u{203A}").foregroundStyle(Theme.subtle)
            SqueakMenu {
                Button { state.choose(.main) } label: { Label(main.label, systemImage: state.choice == .main ? "checkmark" : "folder") }
                if !state.streamOptions.isEmpty { Divider() }
                ForEach(state.streamOptions) { w in
                    Button(w.displayTitle) { state.choose(.existing(w.id)) }
                }
                Divider()
                Button("New stream") { state.choose(.new) }
            } label: {
                HStack(spacing: 6) {
                    Text("In:").foregroundStyle(Theme.muted)
                    Text(verbatim: label).foregroundStyle(Theme.ink).lineLimit(1)
                    Lucide(.chevronDown, size: 12, color: Theme.muted)
                }
                .font(.system(size: 13))
                .padding(.horizontal, 8).frame(height: 26)
                .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Starts in \(label). Change.")
        }
    }

    /// One line when another chat holds Main: the offer, and the two answers. Main stays chosen until "New stream".
    private func busyOffer(_ busy: HostSession) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: MainPlace.busyOffer(title: model.workbenchTitle(busy))).font(Typo.meta).foregroundStyle(Theme.muted)
                .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button(MainPlace.offerNewStream) { state.choose(.new) }.buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.ink)
            Button(MainPlace.offerStay) { state.offer.dismissed = true }.buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
        }
    }

    /// A pond's Start a thread: "pond › stream", the stream picked from the pond's own (newest first, then New stream).
    @ViewBuilder private func pondPlaceLine(_ pond: PondThreadContext) -> some View {
        let label = state.place?.displayTitle ?? (pond.showsPicker ? "New stream" : "This folder")
        if let owner = pond.ownerMac {
            ownerPlaceLine(pond, owner: owner, label: label)
        } else if pond.showsPicker {
            SqueakMenu {
                ForEach(state.streamOptions) { w in
                    Button(w.displayTitle) { state.place = w; state.pond?.choice = .existing(w.id); state.focus += 1 }
                }
                Button("New stream") { state.place = nil; state.pond?.choice = .new; state.focus += 1 }
            } label: {
                HStack(spacing: 6) {
                    crumb(pond: pond.pondName, branch: label)
                    Lucide(.chevronDown, size: 12, color: Theme.muted)
                }
                .padding(.horizontal, 8).frame(height: 26)
                .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Pond and stream: \(pond.pondName) \(label). Change.")
        } else {
            crumb(pond: pond.pondName, branch: label)
        }
    }

    /// A pond shared with me: "pond › Runs on <owner>'s Mac" (the only place when this Mac cannot start the thread, one of two
    /// otherwise). On the owner's Mac there is no stream to pick and nothing is private: the owner's Mac runs it for the pond.
    @ViewBuilder private func ownerPlaceLine(_ pond: PondThreadContext, owner: String, label: String) -> some View {
        let ownerLine = PondStartRequest.placeLine(ownerName: owner)
        let here = pond.showsPicker ? label : "This Mac"
        let current = pond.runsOnOwner ? ownerLine : here
        if pond.canRunHere {
            SqueakMenu {
                Button { state.pond?.runsOnOwner = false; state.focus += 1 } label: { Label("Run on this Mac", systemImage: pond.runsOnOwner ? "laptopcomputer" : "checkmark") }
                Button { state.pond?.runsOnOwner = true; state.focus += 1 } label: { Label(ownerLine, systemImage: pond.runsOnOwner ? "checkmark" : "laptopcomputer") }
            } label: {
                HStack(spacing: 6) {
                    crumb(pond: pond.pondName, branch: current)
                    Lucide(.chevronDown, size: 12, color: Theme.muted)
                }
                .padding(.horizontal, 8).frame(height: 26)
                .background(Theme.surfaceRaised.opacity(0.55), in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Pond and place: \(pond.pondName), \(current). Change.")
        } else {
            crumb(pond: pond.pondName, branch: ownerLine)
        }
    }

    /// Who sees the thread, one line under the message box, with a Private switch.
    private var shareRow: some View {
        HStack(spacing: 8) {
            if let pond = state.pond {
                Text(verbatim: pond.shareLine).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                Spacer(minLength: 4)
                if !pond.runsOnOwner {
                    Text("Private").font(Typo.meta).foregroundStyle(Theme.muted)
                    Toggle("Private", isOn: Binding(get: { state.pond?.isPrivate ?? false }, set: { state.pond?.isPrivate = $0 }))
                        .labelsHidden().toggleStyle(.switch).controlSize(.mini)
                }
            }
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
            presetChip
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
            Text("Leads the thread").font(.system(size: 11)).foregroundStyle(Theme.muted)
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
        .help("The model that leads the thread")
        .accessibilityLabel("Agent and model: \(f.agent.displayName), \(name), leads the thread")
    }

    /// The three shared presets (Claude threads only; Codex keeps the plain model picker), one tap away on the chip row.
    @ViewBuilder private var presetChip: some View {
        let f = state.form
        if !f.presets.isEmpty {
            SqueakMenu {
                ForEach(f.presetChoices, id: \.self) { p in
                    Button { if p != .custom { state.form.apply(preset: p) } } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Lucide(.check, size: 14, color: Theme.ink).opacity(f.activePreset == p ? 1 : 0)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: p == .custom ? "Custom" : f.presetTitle(p))
                                Text(verbatim: p == .custom
                                     ? ChatPresets.description(of: f.currentSetup, agent: f.agent, models: f.models)
                                     : f.presetDescription(p))
                                    .font(.system(size: 11)).foregroundStyle(Theme.muted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
            } label: { chip(f.presetPillLabel) {} }
            .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
            .help(f.presetPillHelp)
            .accessibilityLabel("Preset: \(f.presetPillHelp)")
        }
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
                    NCSegmented(options: f.presetChoices.map { ($0.rawValue, f.presetTitle($0)) }, selection: f.activePreset.rawValue) { pick in
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
        .screen("New thread")
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
