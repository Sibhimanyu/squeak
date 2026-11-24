#if os(iOS)
import SqueakCore
import SwiftUI

/// A pond's Room: its people's messages, Task cards with their state and routing line, and each Duck's state lines,
/// collapsed to one line (tap to expand). Every row, word and switch is the Mac's (`PondRoomDoc`); this only draws them
/// and sends the person's own words, Make task and Drop as signed `pond` commands.
struct PondRoomView: View {
    @Environment(AppModel.self) private var model
    let pondId: String
    @State private var draft = ""
    @State private var expanded: Set<String> = []
    @State private var problem: String?
    @State private var busy: Set<String> = []
    @FocusState private var focused: Bool

    private var doc: PondRoomDoc? { model.roomDoc(pondId) }
    private var sent: [PondRoomPending] { model.roomSent(pondId) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if let offline = doc?.offline {
                            Label(offline, systemImage: "wifi.slash").font(.footnote).foregroundStyle(Theme.muted)
                                .padding(.bottom, 4)
                        }
                        if let doc {
                            if doc.items.isEmpty && sent.isEmpty {
                                Text("Nothing in the Room yet.").font(.footnote).foregroundStyle(Theme.muted)
                            }
                            ForEach(doc.items) { item in row(item, doc: doc).id(item.id) }
                        } else if model.roomLoaded {
                            Text("Your Mac hasn't sent this Room yet. Open the app on your Mac, then pull to refresh.")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        } else {
                            HStack(spacing: 8) { ProgressView(); Text("Loading the Room").font(.footnote).foregroundStyle(Theme.muted) }
                        }
                        ForEach(sent) { pending in PendingBubble(pending: pending, retry: {
                            model.retryRoomPost(pondId: pondId, id: pending.id)
                        }, dismiss: { model.dismissRoomPost(pondId: pondId, id: pending.id) }).id(pending.id) }
                    }
                    .padding(16)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: bottomId) { _, last in
                    if let last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) } }
                }
                .onAppear { if let id = bottomId { proxy.scrollTo(id, anchor: .bottom) } }
            }
            composer
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Room")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.openRoom(pondId) }
        .onDisappear { model.openRoom(nil) }
        .foregroundStyle(Theme.ink)
    }

    /// The newest row, so the page follows new words without jumping when older ones change.
    private var bottomId: String? { sent.last?.id ?? doc?.items.last?.id }

    @ViewBuilder private func row(_ item: PondRoomDoc.Item, doc: PondRoomDoc) -> some View {
        switch item {
        case .message(let m): MessageBubble(message: m, makeTask: m.canTask == true && doc.canTask ? { makeTask(m) } : nil, busy: busy.contains(m.id))
        case .duck(let line): DuckLineRow(line: line, open: expanded.contains(line.id)) {
            withAnimation(.easeOut(duration: 0.18)) {
                if expanded.contains(line.id) { expanded.remove(line.id) } else { expanded.insert(line.id) }
            }
            Haptics.play(.tap)
        }
        case .task(let card): TaskCardView(card: card, busy: busy.contains(card.id), drop: card.canDrop == true && doc.canTask ? { drop(card) } : nil)
        }
    }

    @ViewBuilder private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let problem { Text(problem).font(.footnote).foregroundStyle(Theme.negative) }
            if let doc, !doc.canPost {
                Text(doc.reason ?? "You can read this Room but not post in it.").font(.footnote).foregroundStyle(Theme.muted)
            } else if doc != nil {
                Button { makeTaskPhrase() } label: {
                    Label(PondRoomDoc.makeTaskPhrase, systemImage: "checklist").font(.footnote.weight(.medium))
                }
                .buttonStyle(.bordered).controlSize(.small).tint(Theme.muted)
                .accessibilityHint("Posts these words, and the Mac makes the last message a task")
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message the Room", text: $draft, axis: .vertical)
                        .focused($focused)
                        .lineLimit(1...5)
                        .padding(10)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line))
                    Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.title) }
                        .disabled(trimmed.isEmpty || trimmed.count > PondRoomDoc.maxText)
                        .accessibilityLabel("Send")
                }
                if trimmed.count > PondRoomDoc.maxText {
                    Text("A message is at most \(PondRoomDoc.maxText) characters.").font(.caption).foregroundStyle(Theme.negative)
                }
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private var trimmed: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func send() {
        guard !trimmed.isEmpty, trimmed.count <= PondRoomDoc.maxText else { return }
        problem = nil
        model.postToRoom(pondId: pondId, text: trimmed)
        draft = ""
    }

    private func makeTaskPhrase() {
        problem = nil
        model.postToRoom(pondId: pondId, text: PondRoomDoc.makeTaskPhrase)
    }

    private func makeTask(_ message: PondRoomDoc.Message) {
        problem = nil
        busy.insert(message.id)
        Task {
            let reason = await model.roomAction(pondId: pondId, .roomTask(pondId: pondId, messageId: message.id))
            busy.remove(message.id)
            if let reason { problem = reason }
        }
    }

    private func drop(_ card: PondRoomDoc.TaskCard) {
        problem = nil
        busy.insert(card.id)
        Task {
            let reason = await model.roomAction(pondId: pondId, .roomDrop(pondId: pondId, taskId: card.taskId))
            busy.remove(card.id)
            if let reason { problem = reason }
        }
    }
}

private struct MessageBubble: View {
    let message: PondRoomDoc.Message
    let makeTask: (() -> Void)?
    let busy: Bool

    var body: some View {
        VStack(alignment: message.mine ? .trailing : .leading, spacing: 3) {
            HStack(spacing: 6) {
                if !message.mine { Text(message.who).font(.caption.weight(.medium)).foregroundStyle(Theme.muted) }
                Text(Date(timeIntervalSince1970: Double(message.at) / 1000), format: .dateTime.hour().minute())
                    .font(.caption2).foregroundStyle(Theme.subtle).monospacedDigit()
            }
            Text(message.text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(message.mine ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.line))
                .textSelection(.enabled)
            if let makeTask {
                Button(action: makeTask) { Label("Make task", systemImage: "checklist").font(.footnote) }
                    .buttonStyle(.plain).foregroundStyle(Theme.info).disabled(busy).frame(minHeight: 32)
            }
        }
        .frame(maxWidth: .infinity, alignment: message.mine ? .trailing : .leading)
        .accessibilityElement(children: .contain)
    }
}

/// A Duck's state line: one line, with the rest under a tap.
private struct DuckLineRow: View {
    let line: PondRoomDoc.DuckLine
    let open: Bool
    let toggle: () -> Void

    private var tint: Color {
        switch line.tone {
        case .working: return Theme.working
        case .needs: return Theme.warning
        case .failed: return Theme.negative
        case .done: return Theme.subtle
        }
    }

    var body: some View {
        let canOpen = line.detail != nil
        Button(action: { if canOpen { toggle() } }) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if line.plan == true {
                        Image(systemName: "doc.text").font(.caption2).foregroundStyle(tint).offset(y: -1)
                            .accessibilityLabel("Plan")
                    } else {
                        Circle().fill(tint).frame(width: 7, height: 7).offset(y: -1)
                    }
                    Text(line.who).font(.footnote.weight(.semibold))
                    Text(line.line).font(.footnote).foregroundStyle(Theme.muted).lineLimit(open ? nil : 1)
                    Spacer(minLength: 0)
                    if canOpen {
                        Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(Theme.subtle)
                            .rotationEffect(.degrees(open ? 90 : 0))
                    }
                }
                if open, let detail = line.detail {
                    Text(detail).font(.footnote).foregroundStyle(Theme.muted).padding(.leading, 15)
                        .frame(maxWidth: .infinity, alignment: .leading).transition(.opacity)
                }
                ForEach(line.canvases ?? []) { canvas in
                    HStack(spacing: 8) {
                        Image(systemName: "rectangle.on.rectangle").font(.footnote).foregroundStyle(Theme.muted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(canvas.title).font(.footnote.weight(.semibold)).lineLimit(1)
                            Text(canvas.subtitle + " \u{00B7} View only").font(.caption).foregroundStyle(Theme.subtle).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, 15).frame(minHeight: 32)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Canvas \(canvas.title), \(canvas.subtitle), view only")
                }
            }
            .frame(minHeight: 28, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityHint(canOpen ? (open ? "Collapses the detail" : "Shows the detail") : "")
    }
}

private struct TaskCardView: View {
    let card: PondRoomDoc.TaskCard
    let busy: Bool
    let drop: (() -> Void)?

    private var tint: Color {
        switch card.state {
        case .working: return Theme.working
        case .blocked: return Theme.negative
        case .waiting, .done: return Theme.subtle
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "checklist").font(.footnote).foregroundStyle(Theme.muted)
                Text(card.title).font(.subheadline.weight(.semibold)).lineLimit(3)
                Spacer(minLength: 4)
                Text(card.stateLabel).font(.caption.weight(.medium)).foregroundStyle(tint)
            }
            if let routing = card.routing { Text(routing).font(.footnote).foregroundStyle(Theme.muted) }
            if let result = card.result { Text(result).font(.footnote) }
            if let drop {
                Button(role: .destructive, action: drop) { Text("Drop").font(.footnote) }
                    .buttonStyle(.plain).foregroundStyle(Theme.muted).disabled(busy).frame(minHeight: 32)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(card.state == .blocked ? Theme.negative.opacity(0.5) : Theme.line))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Task: \(card.title). \(card.stateLabel)\(card.routing.map { ". " + $0 } ?? "")\(card.result.map { ". " + $0 } ?? "")")
    }
}

/// Words just sent: drawn like the person's own message, quieter until the Room shows them back.
private struct PendingBubble: View {
    let pending: PondRoomPending
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Text(pending.text)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .opacity(pending.failed == nil ? 0.7 : 1)
            if let failed = pending.failed {
                Text(failed).font(.caption).foregroundStyle(Theme.negative)
                HStack(spacing: 14) {
                    Button("Retry", action: retry)
                    Button("Dismiss", role: .cancel, action: dismiss)
                }.font(.footnote).buttonStyle(.plain).foregroundStyle(Theme.info)
            } else {
                Text("Sending").font(.caption2).foregroundStyle(Theme.subtle)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
#endif
