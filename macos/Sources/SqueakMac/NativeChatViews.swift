import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The messages waiting above the composer of a working Squeak-run chat, Conductor's queue stack: compact cards, newest
/// last. A queued card has Steer (↵), Edit (E) and Delete (⌫) when it is focused; Edit holds it on the host (nothing sends
/// it meanwhile) and opens it in place: ↵ saves, ⌘↵ saves and steers, Esc leaves it as it was. A steer shows dimmed with
/// the glyph until the agent takes it in, then it moves into the transcript.
struct NativeQueueStack: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @State private var busyId: String?
    @State private var editingId: String?
    @State private var draft = ""
    @FocusState private var editorFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let cards = model.native.key == session.key ? model.native.pending.cards : []
        Group {
            if !cards.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(cards) { card in row(card) }
                    if let note = model.native.queueNote {
                        Text(verbatim: note).font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted)
                    }
                }
                .padding(.vertical, 6)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: cards)
        // Leaving the chat mid-edit puts the message back in the queue: a held message is never sent.
        .onDisappear { if let id = editingId { editingId = nil; Task { _ = await model.nativeReleaseQueued(session, id, text: nil) } } }
    }

    @ViewBuilder private func row(_ card: NativePendingStack.Card) -> some View {
        switch card.kind {
        case .steering, .sending: busyCard(card)
        case .queued: if editingId == card.id { editor(card) } else { queued(card) }
        }
    }

    /// A steer the agent has not taken in, or a message still going out: dimmed, with the glyph, nothing to press.
    private func busyCard(_ card: NativePendingStack.Card) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: card.text).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            WorkingGlyph(width: 20, height: 12)
            if card.kind == .steering { Text("Steering…").font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .opacity(SentBubble.sendingOpacity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(card.kind == .steering ? "Steering: \(card.text)" : "Sending: \(card.text)")
    }

    private func queued(_ card: NativePendingStack.Card) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: card.text).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if busyId == card.id {
                DotGridLoader(size: 14)
            } else {
                Button("Steer") { run(card) { await model.nativeSteerQueued(session, card.id) } }
                    .buttonStyle(SecondaryButtonStyle())
                    .help("Steer: send this into the turn now (↵ on the focused message)")
                SqueakMenu {
                    Button("Edit") { edit(card) }
                    Button("Delete", role: .destructive) { run(card) { _ = await model.nativeDeleteQueued(session, card.id) } }
                } label: {
                    Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Edit (E) holds it while you change it; Delete (⌫) drops it")
                .accessibilityLabel("More")
            }
        }
        .disabled(busyId != nil && busyId != card.id)
        .focusable()
        .onKeyPress(.return) { run(card) { await model.nativeSteerQueued(session, card.id) }; return .handled }
        .onKeyPress(.delete) { run(card) { _ = await model.nativeDeleteQueued(session, card.id) }; return .handled }
        .onKeyPress("e") { edit(card); return .handled }
        .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 6)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
    }

    /// The card, opened for editing: the words in a field, Save (↵), Save and steer (⌘↵), Cancel (Esc).
    private func editor(_ card: NativePendingStack.Card) -> some View {
        let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .textFieldStyle(.plain).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1...6)
                .focused($editorFocused)
                .onKeyPress(.escape) { cancel(card); return .handled }
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    save(card, steer: press.modifiers.contains(.command))
                    return .handled
                }
            HStack(spacing: 8) {
                Button("Save") { save(card, steer: false) }.buttonStyle(SecondaryButtonStyle()).disabled(empty).help("Save (↵)")
                Button("Save and steer") { save(card, steer: true) }.buttonStyle(SecondaryButtonStyle()).disabled(empty)
                    .help("Save and steer now (⌘↵)")
                Button("Cancel") { cancel(card) }.buttonStyle(.plain).font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
        }
        .padding(10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.lineStrong))
        .onAppear { editorFocused = true }
    }

    private func edit(_ card: NativePendingStack.Card) {
        guard busyId == nil else { return }
        busyId = card.id
        Task {
            let held = await model.nativeHoldQueued(session, card.id)
            busyId = nil
            if held { draft = card.text; editingId = card.id }
        }
    }

    private func cancel(_ card: NativePendingStack.Card) {
        editingId = nil
        Task { _ = await model.nativeReleaseQueued(session, card.id, text: nil) }
    }

    private func save(_ card: NativePendingStack.Card, steer: Bool) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        editingId = nil
        Task {
            if await model.nativeReleaseQueued(session, card.id, text: text), steer { await model.nativeSteerQueued(session, card.id) }
        }
    }

    private func run(_ card: NativePendingStack.Card, _ work: @escaping () async -> Void) {
        guard busyId == nil else { return }
        busyId = card.id
        Task { await work(); busyId = nil }
    }
}

/// The chat's model and effort, in the composer's control row: a menu of the models for its agent, and the
/// thinking levels of the current one. Claude switches on its live process; Codex carries it to its next turn.
struct NativeModelMenu: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @State private var open = false

    var body: some View {
        picker
            // The catalog is otherwise read only when a Conductor chat is open; a Squeak chat needs it too.
            .task(id: session.agent) { _ = await model.newChatModels() }
    }

    @ViewBuilder private var picker: some View {
        let info = model.native.key == session.key ? model.native.info : nil
        let choices = model.chatModels.filter { $0.agent == session.agent }
        let current = ModelNames.match(info?.model, in: choices)
        let label = Self.label(info: info, current: current)
        if let info, !choices.isEmpty {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Text(verbatim: ModelNames.label(info.model, in: choices)).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                    if let effort = info.effort.map(DaemonChatModel.levelName), !effort.isEmpty {
                        Text(verbatim: effort).font(.system(size: 13)).foregroundStyle(Theme.muted)
                    }
                    Lucide(.chevronDown, size: 11, color: Theme.muted)
                }
                .padding(.horizontal, 6).frame(height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .popover(isPresented: $open, arrowEdge: .top) { pickerList(info: info, choices: choices, current: current) }
            .shortcutHint("Model and thinking level", .modelPicker)
            .accessibilityLabel("Model: \(label)")
            // ⌘/ opens the picker; ⇧⌘E steps to the model's next thinking level.
            .onReceive(NotificationCenter.default.publisher(for: .squeakModelPicker)) { _ in open = true }
            .onReceive(NotificationCenter.default.publisher(for: .squeakNextEffort)) { _ in
                if let current, let next = ModelPicking.nextLevel(after: info.effort, in: current.levels) {
                    model.nativeSetModel(session, modelId: current.id, effort: next)
                }
            }
        } else if !label.isEmpty {
            // The catalog has not come yet: the label stays, and a press asks for it again.
            Button { Task { _ = await model.newChatModels() } } label: {
                HStack(spacing: 6) {
                    Text(verbatim: label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted).lineLimit(1)
                    Lucide(.chevronDown, size: 11, color: Theme.muted)
                }
            }
            .buttonStyle(.plain)
            .help("Loading the models Squeak can switch to")
            .accessibilityLabel("Model: \(label)")
        }
    }

    /// The popover: the agent's models, then the chosen model's thinking levels; a pick applies and closes it.
    private func pickerList(info: NativeSession, choices: [DaemonChatModel], current: DaemonChatModel?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            presetsSection(info: info)
            Text("Model").font(Typo.meta).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 6)
            ForEach(choices) { m in
                row(m.label, selected: m.id == current?.id) {
                    let level = info.effort.flatMap { m.levels.contains($0) ? $0 : nil } ?? m.defaultLevel
                    model.nativeSetModel(session, modelId: m.id, effort: level)
                    open = false
                }
            }
            if let current, !current.levels.isEmpty {
                Divider().padding(.vertical, 4)
                Text("Thinking").font(Typo.meta).foregroundStyle(Theme.muted).padding(.horizontal, 10)
                ForEach(current.levels, id: \.self) { level in
                    row(DaemonChatModel.levelName(level), selected: level == info.effort) {
                        model.nativeSetModel(session, modelId: current.id, effort: level)
                        open = false
                    }
                }
            }
        }
        .padding(6).frame(minWidth: 260, alignment: .leading)
    }

    /// "Presets" at the top, Claude chats only (Codex keeps the plain list): the three shared presets with their models
    /// in one line. A pick sets the model and thinking level now and the code/run split on the next message.
    @ViewBuilder private func presetsSection(info: NativeSession) -> some View {
        let all = ChatPresets.models(model.chatModels, .claude)
        let prefs = ChatPresetPreferences()
        let presets = session.agent == "claude" ? ChatPresets.available(agent: .claude, models: model.chatModels) : []
        if !presets.isEmpty {
            let _ = model.native.presetTick
            let match = ChatPresetMenu.match(
                modelId: ModelNames.match(info.model, in: all)?.id, level: info.effort,
                record: ChatSplitStore().record(for: session.key.stringValue), agent: .claude, models: model.chatModels, preferences: prefs)
            Text("Presets").font(Typo.meta).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 6)
            ForEach(presets, id: \.self) { p in
                if let setup = prefs.setup(for: p, agent: .claude, models: model.chatModels), let id = setup.modelId {
                    Button {
                        model.nativeSetModel(session, modelId: id, effort: setup.level, preset: (p, setup))
                        open = false
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: prefs.title(for: p)).font(Typo.body).foregroundStyle(Theme.ink)
                                Text(verbatim: ChatPresetMenu.subtitle(setup, models: model.chatModels)).font(Typo.meta).foregroundStyle(Theme.muted)
                            }
                            Spacer(minLength: 12)
                            if match == .preset(p) { Lucide(.check, size: 12, color: Theme.ink) }
                        }
                        .padding(.horizontal, 10).padding(.vertical, 4).frame(minHeight: 36).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(match == .preset(p) ? .isSelected : [])
                }
            }
            if match == .custom {
                HStack {
                    Text("Custom").font(Typo.body).foregroundStyle(Theme.muted)
                    Spacer(minLength: 12)
                    Lucide(.check, size: 12, color: Theme.ink)
                }
                .padding(.horizontal, 10).frame(height: 28).accessibilityAddTraits(.isSelected)
            }
            Divider().padding(.vertical, 4)
        }
    }

    private func row(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(verbatim: title).font(Typo.body).foregroundStyle(Theme.ink)
                Spacer(minLength: 12)
                if selected { Lucide(.check, size: 12, color: Theme.ink) }
            }
            .padding(.horizontal, 10).frame(height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    static func label(info: NativeSession?, current: DaemonChatModel?) -> String {
        guard let info else { return "" }
        return ModelNames.composerLabel(model: info.model, effort: info.effort, in: current.map { [$0] } ?? [])
    }
}
