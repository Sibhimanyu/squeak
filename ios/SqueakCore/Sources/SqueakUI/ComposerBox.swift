#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI
import UIKit

/// The one message box of the app (chat reply, New chat, Quick reply): a single rounded container with the
/// text on top (it grows to six lines, then scrolls) and one control row under it: "+" for photos at the left,
/// then the model label (where the chat can show one), the mic, and a round primary button the caller supplies.
///
/// While you dictate, the control row becomes a live waveform with a cross and a check; the heard words stream
/// into the text above and nothing is sent until you press Send.
struct ComposerBox<Setup: View, Primary: View>: View {
    let placeholder: String
    @Binding var text: String
    @Binding var photos: [ChatPhoto]
    var focused: FocusState<Bool>.Binding
    /// Bumped on each clear, so the field is rebuilt and cannot keep text of its own.
    var fieldId = 0
    /// Typing and dictating are off (the reason is shown by the caller).
    var locked = false
    var attachEnabled = true
    var photosLocked = false
    var accessibilityLabel: String
    /// Text or photos waiting: the mic steps back and Send takes over.
    var hasContent: Bool
    var minFieldHeight: CGFloat = 0
    var lineLimit = 6
    @ViewBuilder var setup: Setup
    @ViewBuilder var primary: Primary

    @State private var dictation = DictationController()
    @Environment(\.scenePhase) private var scenePhase

    private var dictating: Bool { dictation.isActive }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                if !photos.isEmpty {
                    PhotoTray(photos: $photos, locked: photosLocked).padding(.horizontal, 2).padding(.bottom, 4)
                }
                field
                controls
            }
            .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 4)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 26, style: .continuous)
                .stroke(focused.wrappedValue || dictating ? Theme.lineStrong : Theme.line, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .onTapGesture { if !locked, !dictating { focused.wrappedValue = true } }
            dictationNote
        }
        .onChange(of: dictation.liveText) { _, new in if dictating { text = new } }
        .onChange(of: dictation.state) { old, new in
            // Back to idle with words: the field already holds them; open the keyboard to edit them.
            let wasActive = [DictationState.recording, .finishing].contains(old)
            if wasActive, new == .idle, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { focused.wrappedValue = true }
        }
        .onChange(of: scenePhase) { _, phase in if phase != .active { leave() } }
        .onChange(of: locked) { _, now in if now { leave() } }
        .onDisappear { leave() }
    }

    /// Stops listening and keeps what was heard in the field.
    private func leave() {
        if let heard = dictation.stopNow() { text = heard }
    }

    // MARK: text

    @ViewBuilder
    private var field: some View {
        if dictating {
            Group {
                if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Listening…").foregroundStyle(Theme.subtle)
                } else {
                    Text(text).foregroundStyle(Theme.ink).lineLimit(lineLimit)
                }
            }
            .font(.body)
            .frame(maxWidth: .infinity, minHeight: max(24, minFieldHeight), alignment: .topLeading)
            .padding(.bottom, 4)
            .accessibilityLabel("Dictating")
            .accessibilityValue(text)
        } else {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...lineLimit)
                .id(fieldId)
                .focused(focused)
                .disabled(locked)
                .frame(minHeight: max(24, minFieldHeight), alignment: .topLeading)
                .padding(.bottom, 4)
                .accessibilityLabel(accessibilityLabel)
                .pasteImages(into: $photos, focused: focused.wrappedValue)
        }
    }

    // MARK: controls

    @ViewBuilder
    private var controls: some View {
        if dictating { listening } else { idleControls }
    }

    private var idleControls: some View {
        HStack(spacing: 0) {
            if attachEnabled && !locked {
                AttachButton(photos: $photos, height: 44, icon: .plus, glyph: 22).frame(width: 44)
            }
            Spacer(minLength: 8)
            setup
            if !locked { micButton }
            primary
        }
        .frame(minHeight: 44)
    }

    private var micButton: some View {
        Button {
            focused.wrappedValue = false
            dictation.start(base: text)
        } label: {
            Lucide(.mic, size: 22, color: hasContent ? Theme.muted : Theme.ink).frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dictate")
        .accessibilityHint("Speak your message. It is turned into text on this phone for you to check before sending.")
    }

    private var listening: some View {
        HStack(spacing: 8) {
            Button {
                text = dictation.base
                dictation.cancel()
            } label: {
                Lucide(.x, size: 20, color: Theme.muted).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel dictation")
            Waveform(levels: dictation.window.levels).frame(maxWidth: .infinity).frame(height: 28)
                .accessibilityHidden(true)
            Button {
                dictation.stop()
            } label: {
                ComposerRound(filled: true) { Lucide(.check, size: 18, color: Theme.primaryText) }
            }
            .buttonStyle(.plain)
            .disabled(dictation.state != .recording)
            .accessibilityLabel("Finish dictation")
        }
        .frame(minHeight: 44)
    }

    @ViewBuilder
    private var dictationNote: some View {
        if case .denied(let why) = dictation.state {
            HStack(spacing: 8) {
                Text(Self.deniedText(why)).font(.footnote).foregroundStyle(Theme.muted)
                if why != .unavailable {
                    Button("Open Settings") { DictationController.openSettings() }
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink).frame(minHeight: 44)
                }
            }
            .padding(.horizontal, 6)
        } else if let note = dictation.note {
            Text(note).font(.footnote).foregroundStyle(Theme.muted).padding(.horizontal, 6)
        }
    }

    private static func deniedText(_ why: DictationDenial) -> String {
        switch why {
        case .microphone: return "Squeak can't use the microphone. Allow it in Settings to dictate."
        case .speech: return "Squeak can't use speech recognition. Allow it in Settings to dictate."
        case .unavailable: return "Speech recognition isn't available right now."
        }
    }
}

/// The round primary control of the box: 36 points of fill inside a 44-point target.
struct ComposerRound<Content: View>: View {
    var filled: Bool
    @ViewBuilder var content: Content

    var body: some View {
        content
            .frame(width: 36, height: 36)
            .background(filled ? Theme.primaryFill : Theme.surfaceRaised, in: Circle())
            .overlay(Circle().stroke(Theme.line).opacity(filled ? 0 : 1))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
    }
}

/// The model label of a chat's box: the model in the main weight, the thinking level lighter, quiet and tappable.
struct SetupLabelText: View {
    let line: String
    let changeable: Bool

    var body: some View {
        let parts = ComposerSetupLabel.split(line)
        HStack(spacing: 4) {
            (Text(parts.model).fontWeight(.medium) + Text(parts.detail.isEmpty ? "" : " " + parts.detail).fontWeight(.light))
                .font(.footnote).foregroundStyle(Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
            if changeable {
                Lucide(.chevronDown, size: 12, color: Theme.muted)
            }
        }
        .frame(minHeight: 44).contentShape(Rectangle())
        .padding(.trailing, 4)
    }
}

/// A live level meter: bars from the microphone, newest at the right.
struct Waveform: View {
    let levels: [Float]

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 2) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule().fill(Theme.ink.opacity(0.75))
                        .frame(width: max(2, (proxy.size.width - CGFloat(levels.count - 1) * 2) / CGFloat(max(levels.count, 1))),
                               height: max(3, proxy.size.height * CGFloat(level)))
                }
            }
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .trailing)
        }
        .animation(.linear(duration: 0.08), value: levels)
    }
}
#endif
