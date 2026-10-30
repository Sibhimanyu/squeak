#if os(iOS)
import SqueakCore
import SwiftUI

/// Settings › New chat presets: the shared Best / Balanced / Save usage, as the Mac's Settings › General shows
/// them. The Mac owns them (`presets` in the phone view); each edit is one signed `presets` command, shown at once
/// and put back with the Mac's reason if it refuses. A name is sent once typing pauses.
struct ChatPresetsSettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var agent = NewChatAgent.claude
    @State private var drafts: [String: String] = [:]
    @State private var nameTasks: [String: Task<Void, Never>] = [:]
    @State private var problem: String?

    private static let shownPresets: [ChatPreset] = [.best, .balanced, .save]
    private var allModels: [PhoneSnapshot.ChatModel] { model.snapshot?.chatModels ?? [] }
    private var workers: [PhoneSnapshot.SplitWorker] { model.snapshot?.chatWorkers ?? [] }
    private var models: [PhoneSnapshot.ChatModel] { allModels.filter { $0.agent == agent.rawValue } }
    private var shared: ChatPresetsDocument? { model.presetsDocument }

    /// What the preset is now: the stored setup, else the built-in rule, else Best, so the pickers always show something.
    private func current(_ preset: ChatPreset) -> ChatSetup {
        ChatPresets.setup(for: preset, agent: agent, models: allModels, workers: workers, shared: shared)
            ?? ChatPresets.setup(for: .best, agent: agent, models: allModels, workers: workers, shared: shared)
            ?? ChatSetup(modelId: models.first?.id)
    }

    private func send(_ change: PresetsChange) {
        Task { problem = await model.changePresets(change) }
    }

    private func edit(_ preset: ChatPreset, _ change: (inout ChatSetup) -> Void) {
        var setup = current(preset)
        change(&setup)
        guard let safe = ChatPresets.sanitised(setup, agent: agent, models: allModels, workers: workers) else { return }
        send(.setup(agent: agent, preset: preset, safe))
    }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering. Changes won't reach it.").font(.footnote).foregroundStyle(Theme.muted) }
            }
            Section {
                Picker("Agent", selection: $agent) {
                    ForEach(NewChatAgent.allCases, id: \.self) { Text(Presentation.agentName($0.rawValue)).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Theme.surface)
            }
            if models.isEmpty {
                Section { Text("Connect Conductor to load the models this Mac can use.").font(.footnote).foregroundStyle(Theme.muted) }
            } else {
                ForEach(Self.shownPresets, id: \.self) { preset in editor(preset) }
            }
            if let problem {
                Section { Text(problem).font(.footnote).foregroundStyle(Theme.muted) }
            }
            Section {} footer: {
                Text("Shared with your Mac and the web through Squeak. Each agent has its own model choices.")
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("New chat presets")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .onDisappear { for preset in Self.shownPresets { flushName(preset) } }
    }

    private func editor(_ preset: ChatPreset) -> some View {
        let setup = current(preset)
        let chat = models.first { $0.id == setup.modelId }
        return Section {
            HStack {
                Text("Name")
                TextField("Name shown in New chat", text: nameBinding(preset))
                    .multilineTextAlignment(.trailing)
                    .submitLabel(.done)
                    .onSubmit { flushName(preset) }
                    .accessibilityLabel("Name shown in New chat")
            }
            .listRowBackground(Theme.surface)
            Picker("Model", selection: Binding(
                get: { setup.modelId ?? models.first?.id ?? "" },
                set: { id in edit(preset) { $0.modelId = id } }
            )) {
                ForEach(models) { Text(ChatPresets.shortName($0.label) + ($0.label.contains("1M") ? " · 1M" : "")).tag($0.id) }
            }
            .listRowBackground(Theme.surface)
            if let chat, !chat.levels.isEmpty {
                Picker("Thinking", selection: Binding(
                    get: { setup.level ?? chat.defaultLevel ?? chat.levels[0] },
                    set: { level in edit(preset) { $0.level = level } }
                )) {
                    ForEach(chat.levels, id: \.self) { Text(ChatPresets.levelName($0).capitalized).tag($0) }
                }
                .listRowBackground(Theme.surface)
            }
            if agent == .claude, !workers.isEmpty {
                workerPicker("Code", value: setup.code) { id in edit(preset) { $0.code = id } }
                workerPicker("Run commands", value: setup.run) { id in edit(preset) { $0.run = id } }
                Toggle(isOn: Binding(
                    get: { setup.planFirst },
                    set: { value in edit(preset) { $0.planFirst = value && ($0.code != nil || $0.run != nil) } }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Ask before changes")
                        Text("Review the plan before delegated work begins.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
                .listRowBackground(Theme.surface)
            }
            Button("Restore defaults") {
                nameTasks[preset.rawValue]?.cancel()
                drafts[preset.rawValue] = nil
                send(.reset(agent: agent, preset: preset))
            }
            .frame(minHeight: 44, alignment: .leading)
            .accessibilityLabel("Restore \(ChatPresets.name(of: preset, shared: shared)) defaults")
            .listRowBackground(Theme.surface)
        } header: {
            Text(ChatPresets.name(of: preset, shared: shared))
        }
    }

    private func workerPicker(_ title: String, value: String?, set: @escaping (String?) -> Void) -> some View {
        Picker(title, selection: Binding(get: { value }, set: set)) {
            Text("Same model").tag(String?.none)
            ForEach(workers) { Text(ChatPresets.shortName($0.label)).tag(String?.some($0.id)) }
        }
        .listRowBackground(Theme.surface)
    }

    /// The name as typed; sent once typing pauses, and again at once on Return or leaving the page.
    private func nameBinding(_ preset: ChatPreset) -> Binding<String> {
        Binding(
            get: { drafts[preset.rawValue] ?? ChatPresets.name(of: preset, shared: shared) },
            set: { value in
                drafts[preset.rawValue] = String(value.prefix(32))
                nameTasks[preset.rawValue]?.cancel()
                nameTasks[preset.rawValue] = Task {
                    try? await Task.sleep(for: .milliseconds(700))
                    guard !Task.isCancelled else { return }
                    flushName(preset)
                }
            }
        )
    }

    private func flushName(_ preset: ChatPreset) {
        nameTasks[preset.rawValue]?.cancel()
        nameTasks[preset.rawValue] = nil
        guard let draft = drafts[preset.rawValue] else { return }
        let clean = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        drafts[preset.rawValue] = nil
        guard clean != ChatPresets.name(of: preset, shared: shared) else { return }
        send(.name(preset: preset, clean.isEmpty || clean == preset.title ? nil : clean))
    }
}
#endif
