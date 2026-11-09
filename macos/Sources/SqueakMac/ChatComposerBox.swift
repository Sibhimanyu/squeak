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
    /// The mode chip, drawn only when the chat's source takes a mode and said which. Interactive only with `onMode`.
    var mode: ComposerMode?
    var onMode: ((ComposerMode) -> Void)?
    /// A card waits on the person: ↵ in the field hands the typed words to it (deny with that reason, or the
    /// question's own answer) instead of adding a line, and nothing else sends.
    var cardReply: ((String) -> Void)?
    /// "ctx 38% left", warning-tinted when low.
    var contextText: String?
    var contextLow = false
    /// Percent of the context used (0...100), drawn as the small ring before "+".
    var contextUsed: Double?
    /// `@` file mentions and `/` commands; nil: no pickers.
    var picker: ComposerPickerSource?
    @ViewBuilder var setup: () -> Setup

    @State private var dictation = DictationController()
    @State private var contentHeight: CGFloat = 0
    @State private var localFocus = 0
    @State private var pick = ComposerPickerModel()
    @State private var fieldHandle = ComposerFieldHandle()
    @State private var caret = 0

    /// About twice the old box: room for two or three lines before it grows.
    private let minH: CGFloat = 48
    private let maxH: CGFloat = 17 * 8 + 12

    var body: some View {
        box
            .overlay(alignment: .topLeading) { pickerOverlay }
            .zIndex(1)
            .accessibilityElement(children: .contain)
            .modifier(OptionalImageDrop(tray: tray))
            .onChange(of: text) { _, new in pick.refresh(text: new, caret: caret) }
            .onChange(of: caret) { _, new in pick.refresh(text: text, caret: new) }
            .onChange(of: picker?.identity) { _, _ in pick.use(picker); pick.refresh(text: text, caret: caret) }
            .onAppear {
                pick.use(editable ? picker : nil)
                dictation.onText = { words in
                    text = DictationState.append(words, to: text)
                    localFocus += 1
                }
            }
            .onChange(of: chatID) { _, _ in dictation.cancel() }
            .onDisappear { dictation.cancel() }
    }

    @ViewBuilder private var pickerOverlay: some View {
        if pick.isOpen {
            ComposerPickerList(model: pick, onPick: accept)
                .alignmentGuide(.top) { $0[.bottom] + 6 }
        }
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let tray { ImageStrip(tray: tray).padding(.leading, 4) }
            if dictation.state.showsMeter {
                DictationBar(dictation: dictation)
            } else {
                ComposerField(
                    text: $text, sendKey: cardReply == nil ? .commandReturnSends : .returnSends, placeholder: placeholder,
                    isEnabled: editable, focusToken: focusToken + localFocus,
                    onSend: {
                        if let cardReply {
                            let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !typed.isEmpty { cardReply(typed) }
                        } else {
                            onSend(working ? sendDefault.primary : .queue)
                        }
                    },
                    onContentHeight: { contentHeight = $0 },
                    onImages: editable && tray != nil ? { tray?.add($0) } : nil,
                    onCaret: { caret = $0 },
                    onPickerKey: pickerKeyHandler,
                    handle: fieldHandle
                )
                .frame(height: min(max(contentHeight, minH), maxH))
                .overlay(alignment: .topTrailing) {
                    // "⌘L to focus", while the field is empty and takes words.
                    if editable, text.isEmpty {
                        Text("⌘L to focus").font(.system(size: 12)).foregroundStyle(Theme.subtle).allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                }
            }
            DictationNotice(dictation: dictation)
            controls
        }
        .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
    }

    private var pickerKeyHandler: ((ComposerPickerKey) -> Bool)? {
        pick.isOpen ? { key in pickerKey(key) } : nil
    }

    private func pickerKey(_ key: ComposerPickerKey) -> Bool {
        switch key {
        case .up: pick.move(-1)
        case .down: pick.move(1)
        case .accept:
            guard !pick.items.isEmpty else { return false }
            accept(pick.selected)
        case .escape: pick.dismiss()
        }
        return true
    }

    private func accept(_ index: Int) {
        guard let c = pick.choice(at: index) else { return }
        fieldHandle.replace(c.range, with: c.text)
    }

    /// One bottom row: model and effort (with its chevron) at the left, then the mode; at the right attach, the
    /// context ring, "+", dictate and the send or stop square.
    private var controls: some View {
        HStack(spacing: 6) {
            setup()
            if let mode { ModeChip(mode: mode, onPick: onMode) }
            Spacer(minLength: 8)
            if editable, let tray {
                AttachButton(tray: tray, symbol: .paperclip)
            } else {
                // Attachments need an editable chat whose source takes them; the button stays so the row is the same.
                Lucide(.paperclip, size: 15, color: Theme.subtle).frame(width: 28, height: 28)
                    .help(editable ? "This chat's source does not take attachments" : "Attachments are available when the chat can be answered")
                    .accessibilityLabel("Attach unavailable")
            }
            if let contextUsed { ContextRing(used: contextUsed, low: contextLow, words: contextText) }
            plusMenu
            micButton
            sendButton
        }
        .frame(minHeight: 32)
    }

    /// "+": attach, mention a file, run a command.
    private var plusMenu: some View {
        Menu {
            if editable, let tray { Button("Attach images…") { tray.pick() }.disabled(tray.isFull) }
            Button("Mention a file (@)") { insertTrigger("@") }
            Button("Run a command (/)") { insertTrigger("/") }
        } label: {
            Lucide(.plus, size: 16, color: editable ? Theme.muted : Theme.subtle).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain).fixedSize()
        .disabled(!editable)
        .help("Attach, mention a file, or run a command")
        .accessibilityLabel("Add to message")
    }

    private func insertTrigger(_ mark: String) {
        text += (text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " ") + mark
        localFocus += 1
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

/// Stop (§8.10, owner's correction 2026-11-09): a square button, an ink tile with a small square cut out of it.
struct RoundStopLabel: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 2).fill(Theme.bg).frame(width: 10, height: 10)
            .frame(width: 30, height: 30)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.ink))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// How much of the context is used: a 16pt ring that turns `negative` when it runs low. The words are its tooltip.
struct ContextRing: View {
    let used: Double
    let low: Bool
    var words: String?

    var body: some View {
        let fraction = min(max(used.isFinite ? used : 0, 0), 100) / 100
        ZStack {
            Circle().stroke(Theme.lineStrong, lineWidth: 2)
            Circle().trim(from: 0, to: fraction).stroke(low ? Theme.negative : Theme.muted, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 16, height: 16).frame(width: 28, height: 28)
        .help(words ?? "")
        .accessibilityElement().accessibilityLabel(words ?? "Context used \(Int(used.rounded())) percent")
    }
}

/// The mode, as glyph and word on a 12% tint of its state colour with a 30% border. A Squeak-run chat passes
/// `onPick`: the chip is a menu of the four modes and ⇧⇥ cycles Ask, Accept edits, Plan (Skip approvals is only
/// ever chosen from the menu). Other sources show it as a label.
struct ModeChip: View {
    let mode: ComposerMode
    var onPick: ((ComposerMode) -> Void)?

    private var tint: Color {
        switch mode.tone {
        case .neutral: Theme.muted
        case .done: Theme.done
        case .working: Theme.working
        case .needsYou: Theme.negative
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
        if let onPick {
            Menu {
                ForEach(NativeModes.menu, id: \.self) { m in
                    Toggle(m.word, isOn: Binding(get: { m == mode }, set: { _ in onPick(m) }))
                }
                Divider()
                Text(NativeModes.skipWarning)
            } label: { chip(showsKey: true) }
            .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain).fixedSize()
            .background(
                Button("") { onPick(NativeModes.next(after: mode)) }
                    .keyboardShortcut(.tab, modifiers: .shift)
                    .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true))
            .help("Permission mode. ⇧⇥ cycles Ask, Accept edits, Plan")
            .accessibilityLabel("Mode: \(mode.word). Press to change")
        } else {
            chip(showsKey: false)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Mode: \(mode.word)")
        }
    }

    private func chip(showsKey: Bool) -> some View {
        HStack(spacing: 6) {
            Lucide(glyph, size: 13, color: tint)
            Text(verbatim: mode.word).font(Typo.body).foregroundStyle(tint)
            if showsKey { KeyCap(text: "⇧⇥") }
        }
        .padding(.horizontal, 9).frame(height: 28)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(tint.opacity(0.3)))
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

/// The Send square: duck fill with an up arrow (§8.9's primary), a quiet tile while there is nothing to send.
struct RoundSendLabel: View {
    let enabled: Bool
    var body: some View {
        Lucide(.arrowUp, size: 16, color: enabled ? Theme.primaryText : Theme.muted)
            .frame(width: 30, height: 30)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(enabled ? Theme.primaryFill : Theme.surfaceRaised.opacity(0.8)))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct OptionalImageDrop: ViewModifier {
    let tray: ImageTray?
    func body(content: Content) -> some View {
        if let tray { content.imageDrop(tray) } else { content }
    }
}
