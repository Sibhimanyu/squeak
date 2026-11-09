import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The messages waiting under a working Squeak-run chat: Steer sends one into the running turn (Codex), or interrupts the
/// turn and starts it next (Claude), Edit takes it back into the composer, Delete drops it.
struct NativeQueueStack: View {
    let session: HostSession
    let onEdit: (String) -> Void
    @Environment(AppModel.self) private var model
    @State private var busyId: String?

    private var agent: String { SessionText.agentName(session.agent) ?? "Agent" }

    var body: some View {
        let items = model.native.key == session.key ? model.native.queue : []
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Queued · \(agent) reads it after this turn")
                    .font(.system(size: Metrics.sectionLabel, weight: .semibold)).foregroundStyle(Theme.muted)
                ForEach(items) { item in row(item) }
                if let note = model.native.queueNote {
                    Text(verbatim: note).font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.vertical, 6)
        }
    }

    private func row(_ item: NativeQueueItem) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: item.text).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if busyId == item.id {
                ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 14, height: 14)
            } else {
                Button("Steer") { run(item) { await model.nativeSteerQueued(session, item) } }
                    .buttonStyle(SecondaryButtonStyle())
                    .help("Steer: send this into the turn now (↵ on the focused message). Claude's turn is interrupted and this starts next.")
                Menu {
                    Button("Edit") { run(item) { if await model.nativeDeleteQueued(session, item) { onEdit(item.text) } } }
                    Button("Delete", role: .destructive) { run(item) { _ = await model.nativeDeleteQueued(session, item) } }
                } label: {
                    Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Edit takes it back into the composer; Delete drops it")
                .accessibilityLabel("More")
            }
        }
        .disabled(busyId != nil && busyId != item.id)
        .focusable()
        .onKeyPress(.return) { run(item) { await model.nativeSteerQueued(session, item) }; return .handled }
        .onKeyPress(.delete) { run(item) { _ = await model.nativeDeleteQueued(session, item) }; return .handled }
        .onKeyPress("e") { run(item) { if await model.nativeDeleteQueued(session, item) { onEdit(item.text) } }; return .handled }
        .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 6)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
    }

    private func run(_ item: NativeQueueItem, _ work: @escaping () async -> Void) {
        guard busyId == nil else { return }
        busyId = item.id
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
        let current = choices.first { $0.id == info?.model }
        let label = Self.label(info: info, current: current)
        if let info, !choices.isEmpty {
            Button { open.toggle() } label: {
                HStack(spacing: 6) {
                    Text(verbatim: current.map(\.label) ?? info.model).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
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
            Text("Model").font(Typo.meta).foregroundStyle(Theme.muted).padding(.horizontal, 10).padding(.top, 6)
            ForEach(choices) { m in
                row(m.label, selected: m.id == info.model) {
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
        .padding(6).frame(minWidth: 220, alignment: .leading)
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
        let name = current.map { $0.label } ?? info.model
        let effort = info.effort.map(DaemonChatModel.levelName)
        return [name, effort].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
