import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// A session opened in the popup, in place of the tabs: back arrow, title and state, the agent's last
/// message with its lettered options, a queued message if there is one, and a reply composer. Reads
/// through the same paths as the quick composer (a transcript read outside the window's focus) and
/// sends through `model.send`, only on a tap or Return.
@MainActor @Observable
final class PopupSessionModel {
    var messages: [ChatMessage] = []
    var loaded = false
    var text = ""
    var sending = false
    var note: String?
    var optionBusy: String?
    @ObservationIgnored var loadedKey: SessionKey?

    func load(_ key: SessionKey, model: AppModel) async {
        if loadedKey != key { messages = []; loaded = false; text = ""; note = nil; loadedKey = key }
        let cached = await model.cachedContextMessages(for: key)
        if messages.isEmpty, !cached.isEmpty { messages = cached }
        while !Task.isCancelled, loadedKey == key {
            if case .messages(let list, _) = await model.liveContextMessages(for: key) { messages = list }
            loaded = true
            try? await Task.sleep(for: .seconds(model.demoMode ? 3600 : 5))
        }
    }

    var lastAssistant: ChatMessage? { messages.last { $0.role == .assistant && !$0.text.isEmpty } }

    /// Our messages after the agent's last one that the daemon says are queued behind the turn.
    var queued: [ChatMessage] {
        let after = messages.drop { $0.id != lastAssistant?.id }.dropFirst()
        return after.filter { m in
            guard m.role == .user else { return false }
            if m.delivery == .queued { return true }
            if case .accepted(_, let d, _)? = m.state { return d == .queued }
            return false
        }
    }
}

struct PopupSessionTop: View {
    @Environment(AppModel.self) private var model
    let key: SessionKey

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                PopupBackButton { PopupNav.shared.back() } .accessibilityLabel("Back")
                if let s = model.session(key) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: SessionText.headline(s)).font(.popup(14, .semibold)).foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.8)
                        Text(verbatim: agentLine(s)).font(.popup(12.5)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    HStack(spacing: 6) {
                        Circle().fill(Theme.color(for: s.state)).frame(width: 8, height: 8)
                        Text(Theme.label(for: s.state)).font(.popup(12.5, .medium)).foregroundStyle(Theme.ink)
                        if let at = s.lastActivityAt { Text("· " + ShortRelativeTime.format(at)).font(.popup(12.5)).foregroundStyle(Theme.muted) }
                    }
                    .fixedSize()
                    .accessibilityElement(children: .combine)
                } else {
                    Text("This chat is no longer listed.").font(.popup(13)).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, PopupMetrics.inset + 1).padding(.top, 14).padding(.bottom, 12)
            PopupDivider()
        }
    }

    private func agentLine(_ s: HostSession) -> String {
        [s.repoName.flatMap { $0.isEmpty ? nil : $0 }, agentName(s)].compactMap { $0 }.joined(separator: " · ")
    }
}

private func agentName(_ s: HostSession) -> String? {
    guard let a = s.agent, !a.isEmpty else { return nil }
    return a.prefix(1).uppercased() + a.dropFirst()
}

struct PopupSessionBand: View {
    @Environment(AppModel.self) private var model
    let key: SessionKey
    let store: PopupSessionModel

    var body: some View {
        let session = model.session(key)
        VStack(alignment: .leading, spacing: 16) {
            if let last = store.lastAssistant {
                let choices = Choices.parse(last.text)
                HStack(alignment: .top, spacing: 12) {
                    Text("AI").font(.popup(12.5, .semibold)).foregroundStyle(Theme.ink)
                        .frame(width: 28, height: 26).background(Circle().fill(Color.wash(0.10)))
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline, spacing: 9) {
                            Text(session.flatMap(agentName) ?? "Agent").font(.popup(14, .semibold)).foregroundStyle(Theme.ink)
                            if let at = last.at { Text(AwakeFormat.clock(at)).font(.popup(12.5)).foregroundStyle(Theme.muted) }
                        }
                        MessageText(markdown: Self.body(last.text, choices: choices), style: Self.style)
                    }
                }
                if !choices.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(choices, id: \.letter) { c in
                            PopupOptionRow(choice: c, busy: store.optionBusy == c.letter, size: .large) { answer(c) }
                                .disabled(store.optionBusy != nil || session.map { !model.canSend($0) } ?? true)
                        }
                    }
                    .padding(.leading, 44)
                }
            } else if store.loaded {
                Text("No message from the agent yet.").font(.popup(13)).foregroundStyle(Theme.muted).padding(.vertical, 20)
            } else {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading…").foregroundStyle(Theme.muted) }
                    .frame(maxWidth: .infinity, minHeight: 80)
            }
            ForEach(store.queued) { m in queuedRow(m) }
            if let note = store.note {
                Text(verbatim: note).font(.popup(12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, PopupMetrics.inset + 1).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func queuedRow(_ m: ChatMessage) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.fill").font(.system(size: 14)).foregroundStyle(Theme.muted)
                .frame(width: 28, height: 26).background(Circle().fill(Color.wash(0.10)))
            VStack(alignment: .leading, spacing: 6) {
                Text(verbatim: m.text).font(.popup(13)).foregroundStyle(Theme.ink).lineSpacing(3)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Color.wash(0.07)))
                Text("Queued").font(.popup(12)).foregroundStyle(Theme.muted)
            }
            .padding(8)
            .popupCard(radius: 11, fill: 0.03, stroke: 0.10)
        }
    }

    private func answer(_ c: Choice) {
        store.optionBusy = c.letter
        store.note = nil
        Task {
            let result = await model.send(c.letter, to: key, answering: true)
            store.optionBusy = nil
            switch result {
            case .accepted: store.note = "Sent \(c.letter)"
            case .none: break
            case .refused(let r), .notSent(let r), .uncertain(let r): store.note = r
            }
        }
    }

    static var style: MessageStyle {
        var s = MessageStyle.squeak
        s.bodySize = 14.5
        s.lineSpacing = 5
        return s
    }

    /// The message without its lettered option lines, which are drawn as rows.
    static func body(_ text: String, choices: [Choice]) -> String {
        guard !choices.isEmpty else { return text }
        let letters = Set(choices.map(\.letter))
        let regex = try? NSRegularExpression(pattern: #"^(?:[-*+]\s+)?(?:\*\*|__)?\(?([A-H])[).:](?:\*\*|__)?\s+"#)
        var seen: Set<String> = []
        let kept = text.components(separatedBy: "\n").filter { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            guard let m = regex?.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)), let r = Range(m.range(at: 1), in: t) else { return true }
            let letter = String(t[r])
            guard letters.contains(letter), !seen.contains(letter) else { return true }
            seen.insert(letter)
            return false
        }
        return kept.joined(separator: "\n").replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The reply composer, Stop for a working chat, and a line saying what Return does.
struct PopupSessionFooter: View {
    @Environment(AppModel.self) private var model
    let key: SessionKey
    let store: PopupSessionModel
    @State private var stopping = false

    var body: some View {
        let session = model.session(key)
        let working = session?.state == .working
        let canSend = session.map { model.canSend($0) } ?? false
        VStack(spacing: 0) {
            PopupDivider()
            HStack(spacing: 10) {
                ComposerField(text: Binding(get: { store.text }, set: { store.text = $0 }), sendKey: .returnSends,
                              placeholder: canSend ? "Reply to \(session.flatMap(agentName) ?? "the agent")…" : "Can't send to this chat from here",
                              isEnabled: canSend && !store.sending, onSend: { send(.queue) }, fontSize: 13,
                              onOptionReturn: working ? { send(.steer) } : nil)
                    .padding(.horizontal, 8)
                    .frame(height: 32)
                    .popupCard(radius: 10, fill: 0.03, stroke: 0.11)
                if working, let session, session.conductorSessionId != nil {
                    Button { stop(session) } label: {
                        HStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 2.5).fill(Theme.needsYou).frame(width: 8, height: 8)
                            Text("Stop")
                        }
                    }
                    .buttonStyle(PopupButtonStyle(kind: .danger, radius: 10, height: 32, hPad: 16, size: 13))
                    .disabled(stopping || model.chatBusy)
                    .accessibilityLabel("Stop this chat's turn")
                }
            }
            .padding(.horizontal, PopupMetrics.inset + 1).padding(.top, 12)
            HStack(spacing: 8) {
                Lucide(.keyboard, size: 14, color: Theme.muted)
                Text(working ? "Return queues it after this turn · ⌥↩ steers now" : "Return sends to this chat")
                    .font(.popup(12.5)).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, PopupMetrics.inset + 3).padding(.top, 12).padding(.bottom, 14)
        }
    }

    private func send(_ mode: SendMode) {
        let text = store.text
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !store.sending else { return }
        store.sending = true
        store.note = nil
        Task {
            let result = await model.send(text, to: key, mode: mode)
            store.sending = false
            switch result {
            case .accepted(_, let delivery, _):
                store.text = ""
                store.note = delivery == .steered ? "Steered into the turn." : delivery == .queued ? "Queued behind the turn." : "Sent."
                await store.load(key, model: model, once: true)
            case .refused(let r), .notSent(let r), .uncertain(let r): store.note = r
            case .none: break
            }
        }
    }

    private func stop(_ s: HostSession) {
        stopping = true
        Task { await model.stopChat(s); stopping = false }
    }
}

extension PopupSessionModel {
    /// One read now, after a send, instead of waiting for the next tick.
    func load(_ key: SessionKey, model: AppModel, once: Bool) async {
        if case .messages(let list, _) = await model.liveContextMessages(for: key) { messages = list }
    }
}
