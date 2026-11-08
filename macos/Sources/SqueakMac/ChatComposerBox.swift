import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The conversation's composer, one rounded box like a chat app's: the text on top (it grows to about eight
/// lines, then scrolls) and one control row under it inside the same box: + at the left, the chat's
/// model · effort, the mic, and a round Send. Dictation replaces the text with a level meter and never sends.
struct ChatComposerBox<Setup: View>: View {
    @Binding var text: String
    let placeholder: String
    let editable: Bool
    var focusToken = 0
    /// The chat's id: dictation stops when it changes.
    let chatID: String
    /// Nil: the chat takes no attachments.
    var tray: ImageTray?
    let canSend: Bool
    let working: Bool
    let agent: String
    let sendHelp: String
    /// What the round button and ⌘↩ do while the agent works; the other mode is in its menu and on ⇧⌘↩.
    var sendDefault = SendDefault(.queue)
    let onSend: (SendMode) -> Void
    /// What the state asks of the round button (§8.10); `canStop` is whether this chat has a way to stop.
    var phase: ComposerPhase = .idle
    var canStop = false
    var onStop: () -> Void = {}
    /// The mode chip, drawn only when the chat's source takes a mode and said which. Not interactive yet.
    var mode: ComposerMode?
    /// "ctx 38% left", warning-tinted when low.
    var contextText: String?
    var contextLow = false
    @ViewBuilder var setup: () -> Setup

    @State private var dictation = DictationController()
    @State private var contentHeight: CGFloat = 0
    @State private var localFocus = 0

    private let minH: CGFloat = 24
    private let maxH: CGFloat = 17 * 8 + 12

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let tray { ImageStrip(tray: tray).padding(.leading, 4) }
            if dictation.state.showsMeter {
                DictationBar(dictation: dictation)
            } else {
                ComposerField(
                    text: $text, sendKey: .commandReturnSends, placeholder: placeholder,
                    isEnabled: editable, focusToken: focusToken + localFocus, onSend: { onSend(working ? sendDefault.primary : .queue) },
                    onContentHeight: { contentHeight = $0 },
                    onImages: editable && tray != nil ? { tray?.add($0) } : nil
                )
                .frame(height: min(max(contentHeight, minH), maxH))
            }
            DictationNotice(dictation: dictation)
            controls
        }
        .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.lineStrong))
        .accessibilityElement(children: .contain)
        .modifier(OptionalImageDrop(tray: tray))
        .onAppear {
            dictation.onText = { words in
                text = DictationState.append(words, to: text)
                localFocus += 1
            }
        }
        .onChange(of: chatID) { _, _ in dictation.cancel() }
        .onDisappear { dictation.cancel() }
    }

    private var controls: some View {
        HStack(spacing: 6) {
            if editable, let tray {
                AttachButton(tray: tray, symbol: .paperclip)
            } else {
                // Attachments need an editable chat whose source takes them; the button stays so the row is the same.
                Lucide(.paperclip, size: 15, color: Theme.subtle).frame(width: 28, height: 28)
                    .help(editable ? "This chat's source does not take attachments" : "Attachments are available when the chat can be answered")
                    .accessibilityLabel("Attach unavailable")
            }
            if let mode { ModeChip(mode: mode) }
            setup()
            Spacer(minLength: 8)
            if let contextText {
                Text(verbatim: contextText).font(Typo.meta).monospacedDigit()
                    .foregroundStyle(contextLow ? Theme.needsYou : Theme.muted).lineLimit(1)
            }
            micButton
            sendButton
        }
        .frame(minHeight: 30)
    }

    private var micButton: some View {
        Button { dictation.toggle() } label: {
            Lucide(.mic, size: 15, color: editable ? Theme.muted : Theme.subtle)
                .frame(width: 28, height: 28).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!editable || dictation.isActive)
        .keyboardShortcut("d", modifiers: [.command, .shift])
        .help("Dictate (⇧⌘D). Spoken on this Mac; nothing is sent until you press Send")
        .accessibilityLabel("Dictate a message")
    }

    @ViewBuilder private var sendButton: some View {
        let ready = canSend && !dictation.isActive
        if ComposerPrompt.button(phase: phase, hasContent: canSend, canStop: canStop) == .stop {
            Button(action: onStop) { RoundStopLabel() }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop")
                .help("Stop this turn (⌘.)")
        } else if working {
            // Click does the default (Settings › Sending); the arrow or a click-and-hold offers the other.
            let primary = sendDefault.primary, other = sendDefault.other
            Menu {
                Button("\(SendDefault.title(primary)): \(SendDefault.explanation(primary))") { onSend(primary) }
                Button("\(SendDefault.title(other)): \(SendDefault.explanation(other))") { onSend(other) }
            } label: {
                RoundSendLabel(enabled: ready)
            } primaryAction: {
                onSend(primary)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .disabled(!ready)
            .accessibilityLabel("\(SendDefault.title(primary)) message")
            .accessibilityHint("\(SendDefault.title(other)) is in its menu, or press Shift-Command-Return.")
            .help(sendDefault.help(agent: agent))
            shortcut(primary, [.command], ready)
            shortcut(other, [.command, .shift], ready)
        } else {
            Button { onSend(.queue) } label: { RoundSendLabel(enabled: ready) }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!ready)
                .accessibilityLabel("Send message")
                .help(sendHelp)
        }
    }

    private func shortcut(_ mode: SendMode, _ modifiers: EventModifiers, _ ready: Bool) -> some View {
        Button("") { onSend(mode) }
            .keyboardShortcut(.return, modifiers: modifiers)
            .disabled(!ready)
            .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
    }
}

/// Stop (§8.10): a needs-you-red square on `surface-raised`.
struct RoundStopLabel: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 2).fill(Theme.needsYou).frame(width: 10, height: 10)
            .frame(width: 30, height: 30)
            .background(Circle().fill(Theme.surfaceRaised))
            .overlay(Circle().strokeBorder(Theme.line))
            .contentShape(Circle())
    }
}

/// The mode, as glyph and word on a 12% tint of its state colour with a 30% border. Never interactive here: a
/// chat's mode changes in its own source until native requests land (phase 5).
struct ModeChip: View {
    let mode: ComposerMode

    private var tint: Color {
        switch mode.tone {
        case .neutral: Theme.muted
        case .done: Theme.done
        case .working: Theme.working
        case .needsYou: Theme.needsYou
        }
    }

    private var glyph: LucideName {
        switch mode {
        case .ask: .shield
        case .acceptEdits: .filePen
        case .plan: .clipboardList
        case .skipApprovals: .zapOff
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Lucide(glyph, size: 13, color: tint)
            Text(verbatim: mode.word).font(Typo.body).foregroundStyle(tint)
        }
        .padding(.horizontal, 9).frame(height: 28)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(tint.opacity(0.3)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Mode: \(mode.word)")
    }
}

/// The line under the composer, a fixed 18pt so nothing jumps: a problem in words when there is one, else the
/// live keys of the state.
struct ComposerHintLine: View {
    var problem: String?
    var keys: [KeyHint]
    var help: String?

    var body: some View {
        HStack(spacing: 14) {
            if let problem {
                Text(verbatim: problem).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
            } else {
                ForEach(Array(keys.enumerated()), id: \.offset) { _, k in
                    HStack(spacing: 5) {
                        KeyCap(text: k.key)
                        Text(verbatim: k.label).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(height: 18)
        .help(help ?? "")
        .accessibilityElement(children: .combine)
    }
}

/// The round Send: duck fill with an up arrow (§8.9's primary), a quiet disc while there is nothing to send.
struct RoundSendLabel: View {
    let enabled: Bool
    var body: some View {
        Lucide(.arrowUp, size: 16, color: enabled ? Theme.primaryText : Theme.muted)
            .frame(width: 30, height: 30)
            .background(Circle().fill(enabled ? Theme.primaryFill : Theme.surfaceRaised.opacity(0.8)))
            .contentShape(Circle())
    }
}

private struct OptionalImageDrop: ViewModifier {
    let tray: ImageTray?
    func body(content: Content) -> some View {
        if let tray { content.imageDrop(tray) } else { content }
    }
}
