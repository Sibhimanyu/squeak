import SwiftUI
import SqueakMacCore

/// The messages waiting under a working Conductor chat: Steer sends one into the running turn now, Edit takes it
/// back into the composer, Delete drops it. Shows nothing when the queue is empty or unreadable.
///
/// Integration (one line, in SessionDetailView between the timeline and the composer):
/// `QueueStack(model: model, sessionId: <conductor session id>, isWorking: isWorking, onEdit: { text in <put text in the composer draft> })`
struct QueueStack: View {
    let model: AppModel
    let sessionId: String
    let isWorking: Bool
    /// Called with the text of a message that was deleted for editing, to put back in the composer.
    let onEdit: (String) -> Void

    @State private var store: QueueStore?
    @State private var showAll = false
    @AppStorage("queueSteerNoteSeen") private var noteSeen = false

    private let collapsedCount = 2

    var body: some View {
        Group {
            if let store, !store.items.isEmpty {
                content(store)
            }
        }
        .task(id: "\(sessionId)-\(isWorking)") {
            let store = self.store ?? model.makeQueueStore()
            self.store = store
            if isWorking {
                await store.poll(sessionId: sessionId)
            } else {
                await store.refresh(sessionId: sessionId)
            }
        }
        .onChange(of: sessionId) { _, _ in
            store?.clear()
            showAll = false
        }
    }

    private func content(_ store: QueueStore) -> some View {
        let items = store.items
        let shown = showAll ? items : Array(items.prefix(collapsedCount))
        return VStack(alignment: .leading, spacing: 8) {
            Text("Queued · Claude reads them after this turn")
                .font(.system(size: Metrics.sectionLabel, weight: .semibold))
                .foregroundStyle(Theme.muted)
            ForEach(shown) { item in card(item, store: store) }
            if items.count > collapsedCount {
                Button(showAll ? "Show fewer" : "Show all \(items.count)") { showAll.toggle() }
                    .buttonStyle(.plain)
                    .font(.system(size: Metrics.rowMeta, weight: .medium))
                    .foregroundStyle(Theme.muted)
            }
            if let problem = store.problem {
                Text(problem).font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted)
            }
            if !noteSeen {
                HStack(alignment: .top, spacing: 6) {
                    Text("Steer sends a queued message into the turn that is running now, instead of waiting for it to end.")
                        .font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                    Button("Got it") { noteSeen = true }
                        .buttonStyle(.plain).font(.system(size: Metrics.rowMeta, weight: .medium)).foregroundStyle(Theme.ink)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func card(_ item: QueuedMessage, store: QueueStore) -> some View {
        let resting = store.busyId == item.id
        return VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: item.text)
                .font(.system(size: 13))
                .foregroundStyle(Theme.ink)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 6) {
                Button("Steer") { Task { await store.steer(item, sessionId: sessionId) } }
                    .buttonStyle(SteerButtonStyle())
                    .help("Send this into the turn that is running now")
                Button("Edit") {
                    Task { if await store.delete(item, sessionId: sessionId) { onEdit(item.text) } }
                }
                .buttonStyle(QueueButtonStyle())
                .help("Take it back into the composer")
                Button("Delete") { Task { await store.delete(item, sessionId: sessionId) } }
                    .buttonStyle(QueueButtonStyle())
                Spacer(minLength: 0)
            }
            .disabled(resting || store.busyId != nil)
        }
        .padding(10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
    }
}

/// The one yellow in the stack: the primary action.
private struct SteerButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
            .padding(.horizontal, 12).frame(height: Metrics.button)
            .background(isEnabled ? (configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill) : Theme.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: Radius.control))
    }
}

private struct QueueButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 12).frame(height: Metrics.button)
            .background(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .opacity(isEnabled ? 1 : 0.5)
    }
}
