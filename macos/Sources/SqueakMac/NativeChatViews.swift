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
            Menu {
                Section("Model") {
                    ForEach(choices) { m in
                        Toggle(m.label, isOn: Binding(get: { m.id == info.model }, set: { _ in
                            let level = info.effort.flatMap { m.levels.contains($0) ? $0 : nil } ?? m.defaultLevel
                            model.nativeSetModel(session, modelId: m.id, effort: level)
                        }))
                    }
                }
                if let current, !current.levels.isEmpty {
                    Section("Thinking") {
                        ForEach(current.levels, id: \.self) { level in
                            Toggle(DaemonChatModel.levelName(level), isOn: Binding(get: { level == info.effort }, set: { _ in
                                model.nativeSetModel(session, modelId: current.id, effort: level)
                            }))
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(verbatim: current.map(\.label) ?? info.model).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                    if let effort = info.effort.map(DaemonChatModel.levelName), !effort.isEmpty {
                        Text(verbatim: effort).font(.system(size: 13)).foregroundStyle(Theme.muted)
                    }
                    Lucide(.chevronDown, size: 11, color: Theme.muted)
                }
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("Change the model or thinking level")
            .accessibilityLabel("Model: \(label)")
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

    static func label(info: NativeSession?, current: DaemonChatModel?) -> String {
        guard let info else { return "" }
        let name = current.map { $0.label } ?? info.model
        let effort = info.effort.map(DaemonChatModel.levelName)
        return [name, effort].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}
