import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

/// Needs you, as on the iPhone: a decision card per chat that waits on you, newest first. Each shows
/// the agent's question, its full message on request, one-tap lettered choices and an inline reply.
/// Nothing is sent but by a tap or Return.
struct NeedsYouPage: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let list = model.needsYouSessions
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Needs you").font(.system(size: 26, weight: .bold)).accessibilityAddTraits(.isHeader)
                    Text(list.isEmpty ? "Nothing is waiting on you." : "\(list.count) chat\(list.count == 1 ? "" : "s") waiting for an answer")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                }
                if list.isEmpty {
                    VStack(spacing: Space.m) {
                        DuckMark(width: 64)
                        Text("All caught up").font(Typo.heading).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 48)
                    .accessibilityElement(children: .combine)
                } else {
                    ForEach(list) { NeedsYouDecision(session: $0) }
                }
            }
            .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, Space.xl)
        }
        .scrollContentBackground(.hidden)
    }
}

struct NeedsYouDecision: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @State private var expanded = false
    @State private var replying = false
    @State private var text = ""
    @State private var sending: String?
    @State private var note: String?
    @State private var askResult: AnswerOutcome?
    @FocusState private var fieldFocused: Bool

    private var question: String? { model.question(for: session.key) }
    private var full: String? { model.lastAgentText(session.key) }
    private var canReply: Bool { model.canSend(session) && model.isConnected }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        DecisionCard {
            VStack(alignment: .leading, spacing: Space.m) {
                Button { model.select(session.key) } label: {
                    HStack(alignment: .top, spacing: Space.m) {
                        StateDot(state: .blocked).frame(height: 19)
                        SessionRowLines(session: session)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if let shown = expanded ? full : question, !shown.isEmpty {
                    MessageInlineText(markdown: shown, style: .squeak)
                        .lineLimit(expanded ? nil : 4)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                if let full, !full.isEmpty, full != question {
                    Button(expanded ? "Hide full message" : "Show full message") { expanded.toggle() }
                        .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
                }

                if let shown = model.askDisplay(for: session.key) {
                    AskCard(ask: shown.ask, compact: true, canSend: canReply, onOpen: { model.select(session.key) },
                            onSend: { await model.answer($0, for: session.key) }, result: shown.outcome ?? askResult)
                        .id(shown.ask.toolUseId)
                } else if canReply {
                    let choices = model.choices(for: session.key)
                    if !choices.isEmpty {
                        ChoiceChips(choices: choices, isEnabled: sending == nil) { send($0.letter) }
                    }
                    if replying { replyField } else {
                        Button("Reply") { replying = true; fieldFocused = true }
                            .buttonStyle(.plain).font(Typo.label).foregroundStyle(Theme.muted)
                    }
                } else {
                    Text("Open the chat to answer.").font(Typo.meta).foregroundStyle(Theme.muted)
                }
                if let note { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted) }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var replyField: some View {
        HStack(spacing: Space.s) {
            TextField("Message for \(SessionText.headline(session))", text: $text)
                .textFieldStyle(.plain).font(Typo.body).focused($fieldFocused)
                .onSubmit { send(trimmed, clear: true) }
                .onExitCommand { replying = false; text = "" }
            Button { send(trimmed, clear: true) } label: {
                Lucide(.arrowUp, size: 16, color: trimmed.isEmpty ? Theme.muted : Theme.primaryText)
                    .frame(width: 24, height: 24)
                    .background(trimmed.isEmpty ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: Radius.control))
            }
            .buttonStyle(.plain).disabled(trimmed.isEmpty || sending != nil).accessibilityLabel("Send reply")
        }
        .padding(.leading, 12).padding(.trailing, 4).frame(height: 32)
        .background(Theme.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    /// A letter answers what the agent last said (so a stale tap is refused); free text is a plain reply.
    private func send(_ message: String, clear: Bool = false) {
        guard !message.isEmpty, sending == nil else { return }
        sending = message
        note = nil
        let isLetter = !clear
        Task {
            let result = await model.send(message, to: session.key, answering: isLetter)
            sending = nil
            switch result {
            case .accepted: note = "Sent"; if clear { text = ""; replying = false }
            case .none: break
            default: note = "Not sent. Open the chat to answer."
            }
        }
    }
}
