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
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Needs you").font(.system(size: Metrics.pageTitle, weight: .bold)).accessibilityAddTraits(.isHeader)
                    Text(list.isEmpty ? "Nothing is waiting on you." : "\(list.count) chat\(list.count == 1 ? "" : "s") need\(list.count == 1 ? "s" : "") your decision")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                    if !list.isEmpty {
                        Text("Choose an answer to send it back to the right chat.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
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
            .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, Space.xl)
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
        NeedsYouCardChrome {
            VStack(alignment: .leading, spacing: 8) {
                Button { model.select(session.key) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        TimelineView(.periodic(from: .now, by: 30)) { ctx in
                            HStack(spacing: 6) {
                                Text(verbatim: SessionText.secondLine(session).replacingOccurrences(of: " \u{00B7} ", with: " \u{2022} "))
                                    .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                                Spacer(minLength: Space.s)
                                if let at = session.lastActivityAt {
                                    Text(verbatim: ShortRelativeTime.format(at, now: ctx.date))
                                        .font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.muted)
                                }
                            }
                        }
                        Text(verbatim: SessionText.headline(session)).font(.system(size: Metrics.cardTitle, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
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
                    Button { expanded.toggle() } label: {
                        Text(expanded ? "Hide full message" : "Show full message").underline().font(.system(size: 12)).foregroundStyle(Theme.ink.opacity(0.8))
                    }
                    .buttonStyle(.plain)
                }

                if let shown = model.askDisplay(for: session.key) {
                    AskCard(ask: shown.ask, compact: true, canSend: canReply, onOpen: { model.select(session.key) },
                            onSend: { await model.answer($0, for: session.key) }, result: shown.outcome ?? askResult)
                        .id(shown.ask.toolUseId)
                } else if canReply {
                    let parsed = Choices.parseFull(full)
                    let choices = parsed?.options ?? []
                    if !choices.isEmpty {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)],
                                  spacing: 8) {
                            ForEach(choices, id: \.letter) { c in
                                DecisionChoiceButton(choice: c, recommended: parsed?.recommended == c.letter,
                                                     isEnabled: sending == nil) { send(c.letter) }
                            }
                        }
                    }
                    replyField
                } else {
                    Text("Open the chat to answer.").font(Typo.meta).foregroundStyle(Theme.muted)
                }
                if let note { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted) }
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var replyField: some View {
        HStack(spacing: 8) {
            TextField("Reply with something else\u{2026}", text: $text)
                .textFieldStyle(.plain).font(.system(size: 13)).focused($fieldFocused)
                .onSubmit { send(trimmed, clear: true) }
                .padding(.horizontal, 10).frame(height: Metrics.field)
                .background(Theme.bg.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
            Button { send(trimmed, clear: true) } label: {
                Text("Send").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(trimmed.isEmpty ? Theme.ink : Theme.primaryText)
                    .frame(width: 56, height: Metrics.field)
                    .background(trimmed.isEmpty ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain).disabled(trimmed.isEmpty || sending != nil).accessibilityLabel("Send reply")
        }
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

/// The card for a chat that waits on you: surface, hairline stroke, radius 12, and a coral bar down its left edge.
private struct NeedsYouCardChrome<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .padding(.leading, 20).padding(.trailing, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface.opacity(0.7))
            .overlay(alignment: .leading) { Rectangle().fill(Theme.needsYou).frame(width: 5) }
            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.lineStrong))
    }
}

/// A lettered option as a wide button; "Recommended" is a quiet pill, never a state colour.
private struct DecisionChoiceButton: View {
    let choice: Choice
    let recommended: Bool
    let isEnabled: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(verbatim: "\(choice.letter))").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                Text(verbatim: choice.label).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(2)
                    .multilineTextAlignment(.leading)
                if recommended {
                    Text("Recommended").font(.system(size: 11)).foregroundStyle(Theme.ink.opacity(0.8))
                        .padding(.horizontal, 8).frame(height: 20)
                        .background(Theme.surfaceRaised, in: Capsule())
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .background(Theme.bg.opacity(hovering && isEnabled ? 0.2 : 0.45), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!isEnabled).onHover { hovering = $0 }
        .accessibilityLabel("Answer \(choice.letter): \(choice.label)\(recommended ? ", recommended" : "")")
    }
}
