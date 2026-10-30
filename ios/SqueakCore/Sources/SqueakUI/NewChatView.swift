#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// "New chat": where, what to do, and one tap on how it works. The default screen is only what starts a
/// chat: the workspace, the message (with photos) and Send, with three presets (Best, Balanced, Save
/// usage) under it; the agent, model, thinking, who codes and runs, and plan first sit behind Customize.
/// The phone only offers what the Mac listed (workspaces, models, workers); the Mac checks again, and
/// the command is signed on this phone behind Face ID, like a reply. Presets live in `ChatPresets`.
struct NewChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    let workspaces: [PhoneSnapshot.Workspace]
    @State private var workspaceId: String?
    @State private var agent = NewChatAgent.claude
    @State private var setup = ChatSetup()
    @State private var settled = false
    /// The message box takes the keyboard once, when the page opens; coming back from the workspace picker leaves
    /// it alone, since a keyboard rising while the page slides back in was left covering Send.
    @State private var focusedOnce = false
    @State private var customizing = false
    @State private var text = ""
    @State private var photos: [ChatPhoto] = []
    /// "Sending photo 1 of 2…" while they upload.
    @State private var uploading: String?
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private let store = ChatChoiceStore()
    static let maxCharacters = 20_000

    /// `project` (a repo name) starts the chat in that project's first workspace, from its own page;
    /// otherwise the last workspace used, if the Mac still lists it.
    init(workspaces: [PhoneSnapshot.Workspace], project: String? = nil) {
        self.workspaces = workspaces
        let args = ProcessInfo.processInfo.arguments
        let remembered = ChatChoiceStore().lastWorkspace.flatMap { id in workspaces.first { $0.id == id } }
        let first = project.flatMap { name in workspaces.first { Presentation.split(label: $0.label).repo == name } } ?? remembered ?? workspaces.first
        _workspaceId = State(initialValue: first?.id)
        _agent = State(initialValue: first?.agent ?? .claude)
        if args.contains("-squeak-newchat-filled") {
            _text = State(initialValue: "Add a retry with backoff to the payment webhook, and cover it with a test.")
        }
        if args.contains("-squeak-newchat-customize") { _customizing = State(initialValue: true) }
        if args.contains("-squeak-newchat-error") {
            _problem = State(initialValue: "That workspace isn't available any more. Pick another.")
        }
    }

    private var workspace: PhoneSnapshot.Workspace? { workspaces.first { $0.id == workspaceId } }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var tooLong: Bool { trimmed.count > Self.maxCharacters }
    private var canStart: Bool { workspace != nil && (!trimmed.isEmpty || !photos.isEmpty) && !tooLong && !sending }

    private var allModels: [PhoneSnapshot.ChatModel] { model.snapshot?.chatModels ?? [] }
    /// The models a Claude chat can hand work to; empty from a Mac older than the split, which hides it.
    private var workers: [PhoneSnapshot.SplitWorker] { model.snapshot?.chatWorkers ?? [] }
    /// The Mac's shared presets; absent from an older Mac, which keeps the built-in ones.
    private var shared: ChatPresetsDocument? { model.presetsDocument }
    private var models: [PhoneSnapshot.ChatModel] { allModels.filter { $0.agent == agent.rawValue } }
    private var chosen: PhoneSnapshot.ChatModel? { models.first { $0.id == setup.modelId } ?? models.first }
    private var presets: [ChatPreset] { ChatPresets.available(agent: agent, models: allModels, workers: workers, shared: shared) }
    private var kind: ChatPreset { ChatPresets.preset(of: setup, agent: agent, models: allModels, workers: workers, shared: shared) }
    private var summary: String { ChatPresets.summary(of: setup, agent: agent, models: allModels, workers: workers) }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if workspaces.isEmpty {
                    card { Text("Your Mac has no workspace to start a chat in. Create one in Conductor first.")
                        .foregroundStyle(Theme.muted).padding(16) }
                    Spacer(minLength: 0)
                } else {
                    workspaceRow
                    messageCard
                    if let problem { problemRow(problem) }
                    // Part of the page, not a strip pinned under it: the whole page shrinks to fit above the
                    // keyboard, however and whenever the keyboard arrives, so Send and the choices stay in view.
                    bottomBar.padding(.horizontal, -16)
                }
            }
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
            .background(Theme.bg.ignoresSafeArea())
            // A downward swipe while typing puts the keyboard away; it never closes the page (see below).
            .simultaneousGesture(DragGesture(minimumDistance: 12).onEnded { drag in
                if focused, drag.translation.height > 24, abs(drag.translation.height) > abs(drag.translation.width) { focused = false }
            })
            .navigationTitle("New chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            // Swiping down closes the page only when there is nothing to lose: not while typing (that swipe is for
            // the keyboard), not with a draft or photos, not while sending. Cancel always closes it.
            .interactiveDismissDisabled(sending || focused || !trimmed.isEmpty || !photos.isEmpty)
            .sheet(isPresented: $customizing) {
                CustomizeSheet(setup: $setup, agent: $agent, allModels: allModels, workers: workers, shared: shared)
            }
            .onAppear { settle() }
            .task {
                guard !focusedOnce else { return }
                focusedOnce = true
                try? await Task.sleep(for: .milliseconds(350))
                if !customizing { focused = true }
            }
            .onChange(of: agent) { _, new in
                // Each agent has its own models: start from what was last used with it.
                setup = store.restore(agent: new, models: allModels, workers: workers, shared: shared)
            }
            .onChange(of: setup) { _, new in
                if settled { store.save(new, preset: kind, agent: agent) }
            }
            .onChange(of: workspaceId) { _, id in if let id { store.lastWorkspace = id } }
            .onChange(of: model.snapshot?.chatModels) { _, _ in if !settled { settle() } }
        }
        .foregroundStyle(Theme.ink)
    }

    /* ---------- pieces ---------- */

    private func card<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    private var workspaceRow: some View {
        NavigationLink {
            WorkspacePicker(workspaces: workspaces, selection: $workspaceId) { picked in agent = picked.agent }
        } label: {
            card {
                HStack(spacing: 12) {
                    if let workspace { ProjectMark(name: Presentation.split(label: workspace.label).repo ?? workspace.label, size: 32, folder: true) }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(workspace.map { Presentation.split(label: $0.label).repo ?? $0.label } ?? "Choose a workspace")
                            .font(.headline).foregroundStyle(workspace == nil ? Theme.muted : Theme.ink).lineLimit(1)
                        if let workspace, Presentation.split(label: workspace.label).repo != nil {
                            Text(Presentation.split(label: workspace.label).title).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    Lucide(.chevronRight, size: 16, color: Theme.subtle)
                }
                .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 56).contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint("Choose another workspace")
    }

    private var messageCard: some View {
        card {
            ZStack(alignment: .topLeading) {
                TextEditor(text: $text).focused($focused)
                    .pasteImages(into: $photos, focused: focused)
                    .scrollContentBackground(.hidden).padding(.horizontal, 10).padding(.vertical, 6)
                if text.isEmpty {
                    Text("What should it do?").foregroundStyle(Theme.subtle)
                        .padding(.top, 14).padding(.leading, 15).allowsHitTesting(false)
                }
            }
            .frame(maxHeight: .infinity)
            if !photos.isEmpty { PhotoTray(photos: $photos, locked: sending).padding(.horizontal, 14).padding(.bottom, 4) }
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 4) {
                AttachButton(photos: $photos, height: 44).disabled(sending)
                Text(tooLong ? "Over the \(Self.maxCharacters)-character limit." : photos.isEmpty ? "Add a photo" : "\(photos.count) of \(PhotoAttachment.maxPhotos)")
                    .font(.footnote).foregroundStyle(tooLong ? Theme.error : Theme.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
        }
        // Smaller while the keyboard is up, so the choices and Send stay above it on every phone.
        .frame(minHeight: focused ? 88 : 150)
        .animation(.easeOut(duration: 0.2), value: focused)
    }

    private func problemRow(_ message: String) -> some View {
        card {
            HStack(alignment: .top, spacing: 10) {
                StatusDot(color: Theme.error).padding(.top, 6)
                Text(message).foregroundStyle(Theme.ink)
            }
            .padding(14).accessibilityElement(children: .combine)
        }
    }

    /* ---------- how it works ---------- */

    private var bottomBar: some View {
        // While typing, only what you act on: the choices and Send. The heading and the summary come back with
        // the keyboard gone, so nothing is pushed under it.
        VStack(spacing: focused ? 8 : 10) {
            if !focused {
                HStack {
                    Text("How it works").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Button { focused = false; customizing = true } label: {
                        HStack(spacing: 4) {
                            Text("Customize").font(.subheadline.weight(.medium))
                            Lucide(.chevronRight, size: 12, color: Theme.subtle)
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                .padding(.bottom, -6)
            }
            if !presets.isEmpty {
                HStack(spacing: 8) { ForEach(presets, id: \.self) { presetChip($0) } }
            }
            if !focused {
                (presets.isEmpty || kind != .custom ? Text(summary) : Text(ChatPresets.name(of: kind, shared: shared) + "  ").fontWeight(.semibold).foregroundColor(Theme.ink) + Text(summary))
                    .font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            sendButton
        }
        .animation(.easeOut(duration: 0.2), value: focused)
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 2)
        .background(Theme.bg)
    }

    private func presetChip(_ option: ChatPreset) -> some View {
        let selected = option == kind
        return Button {
            if let next = ChatPresets.setup(for: option, agent: agent, models: allModels, workers: workers, shared: shared) { setup = next }
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            Text(ChatPresets.name(of: option, shared: shared)).font(.subheadline.weight(selected ? .semibold : .regular))
                .lineLimit(1).minimumScaleFactor(0.8)
                .foregroundStyle(selected ? Theme.ink : Theme.muted)
                .padding(.horizontal, 4).frame(maxWidth: .infinity, minHeight: 48)
                .background(selected ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? Theme.lineStrong : Theme.line, lineWidth: selected ? 1.5 : 1))
                .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ChatPresets.name(of: option, shared: shared))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private var sendButton: some View {
        Button { Task { await start() } } label: {
            HStack(spacing: 8) {
                if sending { ProgressView().tint(Theme.primaryText) }
                Text(uploading ?? (sending ? "Starting…" : "Send")).font(.headline)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 12))
        .tint(Theme.primaryFill)
        .foregroundStyle(Theme.primaryText)
        .disabled(!canStart)
    }

    /// Starts from what was last used, kept on what the Mac offers; `-squeak-newchat-save` is a demo flag.
    private func settle() {
        guard !allModels.isEmpty || !settled else { return }
        setup = store.restore(agent: agent, models: allModels, workers: workers, shared: shared)
        if ProcessInfo.processInfo.arguments.contains("-squeak-newchat-save"),
           let save = ChatPresets.setup(for: .save, agent: agent, models: allModels, workers: workers, shared: shared) { setup = save }
        settled = true
    }

    private func start() async {
        guard let workspace else { return }
        focused = false
        sending = true
        problem = nil
        // What is on screen is what is sent: the model and level, when the Mac listed any.
        let picked = chosen
        let level = setup.level
        let delegates = agent == .claude
        let split = WorkSplit(code: delegates ? setup.code : nil, run: delegates ? setup.run : nil, planFirst: setup.planFirst ? true : nil)
        // Photos first, to the workspace's own folder; the message then names where each was saved.
        var message = trimmed
        if !photos.isEmpty {
            uploading = "Sending photo 1 of \(photos.count)…"
            let uploaded = await model.upload(photos, to: .workspace(workspace.id)) { done, total in
                uploading = "Sending photo \(min(done + 1, total)) of \(total)…"
            }
            uploading = nil
            switch uploaded {
            case .failed(let why):
                sending = false
                problem = why
                return
            case .saved(let refs):
                message = PhotoAttachment.compose(trimmed, refs: refs)
            }
        }
        let result = await model.startChat(
            in: workspace, agent: agent, text: message,
            model: picked?.id, thinking: picked.flatMap { $0.levels.isEmpty ? nil : (level ?? $0.defaultLevel) },
            // Only to a Mac that listed workers: an older one would start the chat without the split.
            split: workers.isEmpty || split.isEmpty ? nil : split)
        sending = false
        switch result {
        case .started: dismiss()
        case .cancelled: break
        case let .refused(reason): problem = reason
        }
    }
}

/// Everything that is not "start": one line each, grouped, with a short description. Editing here makes
/// the preset label read "Custom" by itself (the preset is derived from the setup).
private struct CustomizeSheet: View {
    @Binding var setup: ChatSetup
    @Binding var agent: NewChatAgent
    let allModels: [PhoneSnapshot.ChatModel]
    let workers: [PhoneSnapshot.SplitWorker]
    let shared: ChatPresetsDocument?
    @Environment(\.dismiss) private var dismiss

    private var models: [PhoneSnapshot.ChatModel] { allModels.filter { $0.agent == agent.rawValue } }
    private var chosen: PhoneSnapshot.ChatModel? { models.first { $0.id == setup.modelId } ?? models.first }
    private var kind: ChatPreset { ChatPresets.preset(of: setup, agent: agent, models: allModels, workers: workers, shared: shared) }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Agent", selection: $agent) {
                        ForEach(NewChatAgent.allCases, id: \.self) { Text(Presentation.agentName($0.rawValue)).tag($0) }
                    }
                    .pickerStyle(.segmented).frame(minHeight: 44)
                } header: { header("Agent") } footer: { footer("Which assistant does the work.") }
                .listRowBackground(Theme.surface)

                if !models.isEmpty {
                    Section {
                        menuRow("Model", value: chosen.map { ChatPresets.shortName($0.label) } ?? "") {
                            Picker("Model", selection: Binding(get: { chosen?.id ?? "" }, set: pickModel)) {
                                ForEach(models) { Text(ChatPresets.shortName($0.label) + ($0.label.contains("1M") ? " · 1M" : "")).tag($0.id) }
                            }
                        }
                        if let chosen, !chosen.levels.isEmpty {
                            Picker("Thinking", selection: Binding(get: { setup.level ?? chosen.defaultLevel ?? "" }, set: { setup.level = $0 })) {
                                ForEach(chosen.levels, id: \.self) { Text(Self.levelName($0)).tag($0) }
                            }
                            .pickerStyle(.segmented).frame(minHeight: 44)
                        }
                    } header: { header("Model") } footer: { footer("More thinking is slower and uses more of your plan.") }
                    .listRowBackground(Theme.surface)
                }

                if !workers.isEmpty {
                    if agent == .claude {
                        Section {
                            workerRow("Writes the code", selection: $setup.code)
                            workerRow("Runs tests and builds", selection: $setup.run)
                        } header: { header("Split the work") } footer: {
                            footer("The chat's model plans and reviews; cheaper ones do the typing.")
                        }
                        .listRowBackground(Theme.surface)
                    }
                    Section {
                        Toggle(isOn: $setup.planFirst) { Text("Plan first").frame(minHeight: 44, alignment: .leading) }
                            .tint(Theme.primaryFill)
                    } header: { header("Before it changes anything") } footer: { footer("Shows you the plan and waits for your go.") }
                    .listRowBackground(Theme.surface)
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(14)
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(ChatPresets.name(of: kind, shared: shared))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.fontWeight(.semibold) } }
        }
        .foregroundStyle(Theme.ink)
        .presentationDetents([.large])
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted).textCase(nil)
    }

    private func footer(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Theme.muted)
    }

    private func pickModel(_ id: String) {
        guard let next = models.first(where: { $0.id == id }) else { return }
        setup.modelId = id
        if let level = setup.level, next.levels.contains(level) { return }
        setup.level = next.defaultLevel ?? next.levels.first
    }

    private func workerName(_ id: String?) -> String {
        guard let id else { return "Same model" }
        return workers.first { $0.id == id }.map { ChatPresets.shortName($0.label) } ?? id
    }

    private func workerRow(_ title: String, selection: Binding<String?>) -> some View {
        menuRow(title, value: workerName(selection.wrappedValue)) {
            Picker(title, selection: selection) {
                Text("Same model").tag(String?.none)
                ForEach(workers) { Text(ChatPresets.shortName($0.label)).tag(String?.some($0.id)) }
            }
        }
    }

    private func menuRow<Options: View>(_ title: String, value: String, @ViewBuilder options: () -> Options) -> some View {
        Menu { options() } label: {
            HStack(spacing: 10) {
                Text(title).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Text(value).foregroundStyle(Theme.muted).lineLimit(1)
                Lucide(.chevronDown, size: 14, color: Theme.subtle)
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(value)")
    }

    private static func levelName(_ level: String) -> String {
        level == "xhigh" ? "X-high" : level.prefix(1).uppercased() + level.dropFirst()
    }
}

/// Every workspace the Mac listed, grouped by project under the project's own icon, searchable by repo
/// or branch.
private struct WorkspacePicker: View {
    let workspaces: [PhoneSnapshot.Workspace]
    @Binding var selection: String?
    let onPick: (PhoneSnapshot.Workspace) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(AppModel.self) private var model
    @State private var query = ""
    /// The repository a new workspace is being made in, while the Mac makes it.
    @State private var creating: String?
    @State private var createProblem: String?

    private struct Group: Identifiable {
        let name: String
        let items: [PhoneSnapshot.Workspace]
        var id: String { name }
    }

    private var groups: [Group] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let shown = q.isEmpty ? workspaces : workspaces.filter { $0.label.localizedCaseInsensitiveContains(q) }
        var byName: [String: [PhoneSnapshot.Workspace]] = [:]
        var order: [String] = []
        for workspace in shown {
            let name = Presentation.split(label: workspace.label).repo ?? workspace.label
            if byName[name] == nil { order.append(name) }
            byName[name, default: []].append(workspace)
        }
        return order.map { Group(name: $0, items: byName[$0] ?? []) }
    }

    var body: some View {
        let groups = groups
        List {
            if let repos = model.snapshot?.repos, !repos.isEmpty, query.isEmpty {
                Section {
                    ForEach(repos) { repo in newRow(repo) }
                } header: {
                    Text("New workspace").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        .textCase(nil).accessibilityAddTraits(.isHeader)
                } footer: {
                    Text(createProblem ?? "A fresh branch from the repository's default branch, made by Conductor on your Mac.")
                        .font(.footnote).foregroundStyle(createProblem == nil ? Theme.muted : Theme.error)
                }
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.items) { workspace in row(workspace, project: group.name) }
                } header: {
                    HStack(spacing: 8) {
                        ProjectMark(name: group.name, size: 22, folder: true)
                        Text(group.name).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    }
                    .textCase(nil).padding(.bottom, 2)
                    .accessibilityAddTraits(.isHeader)
                }
            }
            if groups.isEmpty { ContentUnavailableView.search(text: query).listRowBackground(Color.clear) }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(16)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Workspace")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search workspaces…")
    }

    private func newRow(_ repo: PhoneSnapshot.Repo) -> some View {
        Button {
            creating = repo.id
            createProblem = nil
            Task {
                let (id, problem) = await model.createWorkspace(in: repo)
                creating = nil
                if let id {
                    selection = id
                    dismiss()
                } else {
                    createProblem = problem
                }
            }
        } label: {
            HStack(spacing: 10) {
                ProjectMark(name: repo.name, size: 22, folder: true)
                Text(repo.name).font(.body).lineLimit(1)
                Spacer(minLength: 8)
                if creating == repo.id { ProgressView().controlSize(.small) } else { Image(systemName: "plus").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted).accessibilityHidden(true) }
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.ink)
        .listRowBackground(Theme.surface)
        .disabled(creating != nil)
        .accessibilityLabel(creating == repo.id ? "Making a workspace in \(repo.name)" : "New workspace in \(repo.name)")
    }

    private func row(_ workspace: PhoneSnapshot.Workspace, project: String) -> some View {
        let parts = Presentation.split(label: workspace.label)
        let branch = parts.repo == nil ? workspace.label : parts.title
        return Button {
            selection = workspace.id
            onPick(workspace)
            dismiss()
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(branch).font(.body).lineLimit(1)
                    Text(Presentation.agentName(workspace.defaultAgent)).font(.footnote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                if workspace.id == selection { Lucide(.check, size: 18, label: "Selected", color: Theme.ink) }
            }
            .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.ink)
        .listRowBackground(Theme.surface)
        .accessibilityLabel("\(project), \(branch)")
        .accessibilityAddTraits(workspace.id == selection ? [.isButton, .isSelected] : .isButton)
    }
}
#endif
