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
    let onSend: (SendMode) -> Void
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
                    isEnabled: editable, focusToken: focusToken + localFocus, onSend: { onSend(.queue) },
                    onContentHeight: { contentHeight = $0 },
                    onImages: editable && tray != nil ? { tray?.add($0) } : nil
                )
                .frame(height: min(max(contentHeight, minH), maxH))
            }
            DictationNotice(dictation: dictation)
            controls
        }
        .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 8)
        .background(Theme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.panel, style: .continuous).strokeBorder(Theme.line))
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
            if editable, let tray { AttachButton(tray: tray) }
            Spacer(minLength: 8)
            setup()
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
        if working {
            // Click queues; the arrow or a click-and-hold offers Steer now.
            Menu {
                Button("Steer now: into the turn in progress") { onSend(.steer) }
                Button("Queue: after this turn") { onSend(.queue) }
            } label: {
                RoundSendLabel(enabled: ready)
            } primaryAction: {
                onSend(.queue)
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .disabled(!ready)
            .accessibilityLabel("Queue message")
            .accessibilityHint("Holds it until \(agent) finishes this turn. Steer now is in its menu, or press Shift-Command-Return.")
            .help("Queue: \(agent) reads it after this turn (⌘↩). Steer now: hold, or ⇧⌘↩")
            shortcut(.queue, [.command], ready)
            shortcut(.steer, [.command, .shift], ready)
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
