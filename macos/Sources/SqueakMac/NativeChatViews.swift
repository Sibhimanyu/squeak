import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The messages waiting above the composer of a working Squeak-run chat, the queue stack: compact cards, newest
/// last. A queued card has Steer (↵), Edit (E) and Delete (⌫) when it is focused; Edit holds it on the host (nothing sends
/// it meanwhile) and opens it in place: ↵ saves, ⌘↵ saves and steers, Esc leaves it as it was. A steer shows dimmed with
/// the glyph until the agent takes it in, then it moves into the transcript.
struct NativeQueueStack: View {
    let session: HostSession
    /// Queued messages the transcript already shows as dimmed rows (with their own Steer / Edit / Remove): not drawn twice here.
    /// The transcript draws every queued message (the timeline view): the stack draws none, only how many wait, so a
    /// message never shows in both places or moves from one to the other.
    var transcriptHoldsQueue = false
    var inTranscript: Set<String> = []
    @Environment(AppModel.self) private var model
    @State private var busyId: String?
    @State private var editingId: String?
    @State private var draft = ""
    @FocusState private var editorFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// An edit in progress is kept by chat and message, so leaving the chat (or the app) does not lose it.
    private func draftKey(_ id: String) -> String { ContainerDrafts.native(session.key.stringValue, item: id) }

    var body: some View {
        let all = model.native.key == session.key ? model.native.pending.stackCards : []
        let cards = transcriptHoldsQueue ? [] : all.filter { !($0.kind == .queued && inTranscript.contains($0.id)) }
        let waiting = transcriptHoldsQueue ? max(inTranscript.count, all.filter { $0.kind == .queued }.count) : all.count - cards.count
        Group {
            if !cards.isEmpty || waiting > 1 {
                VStack(alignment: .leading, spacing: 6) {
                    if waiting > 1 {
                        Text(verbatim: "\(waiting) queued").font(Typo.meta).foregroundStyle(Theme.muted)
                            .padding(.horizontal, 4).accessibilityLabel("\(waiting) messages queued, shown in the chat")
                    }
                    ForEach(cards) { card in row(card) }
                    if let note = model.native.queueNote {
                        Text(verbatim: note).font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted)
                    }
                }
                .padding(.vertical, 6)
                .transition(.opacity)
            }
        }
        .animation(Motion.standard, value: cards)
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
            WorkingGlyph(slot: 20)
            if let word = card.label { Text(word).font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted) }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .opacity(SentBubble.sendingOpacity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(card.kind == .steering ? "\(card.label ?? "Steering"): \(card.text)" : "Sending: \(card.text)")
    }

    private func queued(_ card: NativePendingStack.Card) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: card.text).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if busyId == card.id {
                TideGlyph(color: Theme.muted, grid: .mini)
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
        .onChange(of: draft) { _, text in if editingId == card.id { ContainerDrafts.shared.set(text, for: draftKey(card.id)) } }
    }

    private func edit(_ card: NativePendingStack.Card) {
        guard busyId == nil else { return }
        busyId = card.id
        Task {
            let held = await model.nativeHoldQueued(session, card.id)
            busyId = nil
            if held { draft = ContainerDrafts.shared.draft(for: draftKey(card.id), fallback: card.text); editingId = card.id }
        }
    }

    private func cancel(_ card: NativePendingStack.Card) {
        ContainerDrafts.shared.clear(draftKey(card.id))
        editingId = nil
        Task { _ = await model.nativeReleaseQueued(session, card.id, text: nil) }
    }

    private func save(_ card: NativePendingStack.Card, steer: Bool) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        ContainerDrafts.shared.clear(draftKey(card.id))
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

/// A message waiting in the queue, in the transcript: one dimmed line (author, its first words, how many pictures). A
/// click opens it in a sheet with the whole message and what can be done with it: Steer, Edit, Remove.
struct NativeQueuedRow: View {
    let session: HostSession
    /// Nil while the press is still on its way to the host: the line shows, and opens once the host has queued it.
    let queuedId: String?
    let text: String
    let author: String?
    @Environment(AppModel.self) private var model
    @State private var open = false
    @State private var hovering = false
    @State private var steering = false

    var body: some View {
        let summary = QueuedSummary(text)
        HStack(spacing: 8) {
            // The line itself opens the whole message (Edit, Remove, Steer now).
            Button { if queuedId != nil { open = true } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "clock").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                    if let author { Text(verbatim: author).font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted).lineLimit(1) }
                    Text(verbatim: summary.line).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
                    if summary.pictures > 0 {
                        Label(summary.pictures == 1 ? "1 picture" : "\(summary.pictures) pictures", systemImage: "photo")
                            .font(Typo.meta).foregroundStyle(Theme.muted).labelStyle(.titleAndIcon).lineLimit(1).fixedSize()
                    }
                    Spacer(minLength: 0)
                    Text(queuedId == nil ? "Sending…" : "Queued").font(Typo.meta).foregroundStyle(Theme.muted).fixedSize()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open this queued message to edit or remove it")
            .accessibilityLabel("Queued message: \(summary.line)")
            // Steer straight from the line: no sheet in the way.
            if let queuedId {
                Button {
                    guard !steering else { return }
                    steering = true
                    Task { await model.nativeSteerQueued(session, queuedId); steering = false }
                } label: {
                    if steering { TideGlyph(color: Theme.muted, grid: .mini) } else { Text("Steer") }
                }
                .buttonStyle(SecondaryButtonStyle())
                .controlSize(.small)
                .disabled(steering)
                .help("Steer: send this into the running turn now")
                .accessibilityLabel("Steer this message into the running turn")
            }
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted)
                .onTapGesture { if queuedId != nil { open = true } }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(hovering ? Theme.selected : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .onHover { hovering = $0 }
        .sheet(isPresented: $open) {
            if let queuedId { NativeQueuedSheet(session: session, queuedId: queuedId, text: text, author: author, open: $open) }
        }
    }
}

/// A queued message in full, and its actions. Edit holds it on the host (so it is not sent while being changed) and
/// changes the words only; its pictures stay attached. Closing the sheet mid-edit leaves it as it was.
struct NativeQueuedSheet: View {
    let session: HostSession
    let queuedId: String
    let text: String
    let author: String?
    @Binding var open: Bool
    @Environment(AppModel.self) private var model
    @State private var busy = false
    @State private var editing = false
    @State private var held = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var draftKey: String { ContainerDrafts.native(session.key.stringValue, item: queuedId) }
    private var parts: (words: String, paths: [String]) { ImageAttachments.split(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: 6) {
                Text(author.map { "Queued from \($0)" } ?? "Queued message").font(Typo.heading).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
            }
            Text("It goes to the agent when the turn ends. Steer sends it into the running turn now.")
                .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if editing {
                TextEditor(text: $draft)
                    .font(Typo.body).foregroundStyle(Theme.ink).scrollContentBackground(.hidden)
                    .focused($focused)
                    .onChange(of: draft) { _, text in ContainerDrafts.shared.set(text, for: draftKey) }
                    .frame(minHeight: 90, maxHeight: 220)
                    .padding(8)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.lineStrong))
            } else if !parts.words.isEmpty {
                ScrollView {
                    Text(verbatim: parts.words).font(Typo.body).foregroundStyle(Theme.ink).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 220)
            }
            if !parts.paths.isEmpty {
                PictureFlow {
                    ForEach(Array(parts.paths.enumerated()), id: \.offset) { _, path in
                        StepImageView(path: path, caption: nil, card: false, maxHeight: PictureLayout.cardMaxHeight, maxWidth: 420, alwaysShow: true)
                    }
                }
            }
            HStack(spacing: Space.s) {
                if busy { TideGlyph(color: Theme.muted, grid: .mini) }
                if editing {
                    Button("Remove") { remove() }.buttonStyle(SecondaryButtonStyle()).disabled(busy)
                    Spacer(minLength: 0)
                    Button("Cancel") { close() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                    Button("Save and steer") { save(steer: true) }.buttonStyle(SecondaryButtonStyle()).disabled(busy || empty)
                    Button("Save") { save(steer: false) }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(busy || empty)
                } else {
                    Button("Remove") { remove() }.buttonStyle(SecondaryButtonStyle()).disabled(busy)
                    Button("Edit") { edit() }.buttonStyle(SecondaryButtonStyle()).disabled(busy)
                    Spacer(minLength: 0)
                    Button("Close") { close() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                    Button("Steer now") { run { await model.nativeSteerQueued(session, queuedId) } }
                        .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(busy)
                }
            }
        }
        .padding(Space.l).frame(width: 480)
        .background(Theme.surfaceRaised)
        .onDisappear { if held { held = false; Task { _ = await model.nativeReleaseQueued(session, queuedId, text: nil) } } }
    }

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && parts.paths.isEmpty }

    private func run(_ work: @escaping () async -> Void) {
        guard !busy else { return }
        busy = true
        Task { await work(); busy = false; open = false }
    }

    private func close() {
        ContainerDrafts.shared.clear(draftKey)
        if held { held = false; Task { _ = await model.nativeReleaseQueued(session, queuedId, text: nil) } }
        open = false
    }

    private func remove() {
        ContainerDrafts.shared.clear(draftKey)
        held = false
        run { _ = await model.nativeDeleteQueued(session, queuedId) }
    }

    private func edit() {
        guard !busy else { return }
        busy = true
        Task {
            let ok = await model.nativeHoldQueued(session, queuedId)
            busy = false
            if ok { held = true; draft = ContainerDrafts.shared.draft(for: draftKey, fallback: parts.words); editing = true; focused = true }
        }
    }

    private func save(steer: Bool) {
        let t = ImageAttachments.compose(draft, refs: parts.paths)
        guard !t.isEmpty else { return }
        ContainerDrafts.shared.clear(draftKey)
        held = false
        run {
            if await model.nativeReleaseQueued(session, queuedId, text: t), steer { await model.nativeSteerQueued(session, queuedId) }
        }
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
