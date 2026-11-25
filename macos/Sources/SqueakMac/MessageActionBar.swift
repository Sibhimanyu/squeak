import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// New layout (DESIGN.md §8.12, stage 3): the line under a finished turn is not drawn. Its words (time, duration), Copy
/// and "…" are one small raised bar that floats over the message's top trailing corner while the pointer is over the
/// message or any control of the bar has the keyboard. It is an overlay, so showing it never moves a row; it stays in
/// the view tree at zero opacity so Tab reaches Copy (and VoiceOver reads it) without a pointer.
struct MessageActionBar: View {
    let footer: TurnFooter
    /// This message's own text, for the Copy button.
    let messageText: String
    /// The pointer is over the message itself.
    let overMessage: Bool
    @State private var overBar = false
    @State private var copied = false
    @FocusState private var focus: Control?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Control: Hashable { case copy, more }

    private var state: MessageActionBarState {
        MessageActionBarState(hovering: overMessage || overBar, focusWithin: focus != nil)
    }

    var body: some View {
        HStack(spacing: 2) {
            let line = footer.line { $0.formatted(date: .omitted, time: .shortened) }
            if !line.isEmpty {
                Text(verbatim: line).font(Typo.footnote).monospacedDigit().foregroundStyle(Theme.muted).padding(.horizontal, 6)
            }
            Button { copy(messageText) } label: {
                HStack(spacing: 4) {
                    Lucide(copied ? .check : .copy, size: 13, color: Theme.ink)
                    Text(copied ? "Copied" : "Copy").font(Typo.footnote).foregroundStyle(Theme.ink)
                }
                .padding(.horizontal, 6).frame(height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand().focused($focus, equals: .copy)
            .help("Copy this message").accessibilityLabel("Copy this message")
            SqueakMenu {
                Button("Copy whole turn") { copy(footer.turnText) }
            } label: {
                Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().pointerHand().focused($focus, equals: .more)
            .help("More").accessibilityLabel("More")
        }
        .padding(.horizontal, 4).padding(.vertical, 2)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
        .onHover { overBar = $0 }
        .opacity(state.opacity)
        // Invisible, it must not catch the pointer meant for the message beneath it.
        .allowsHitTesting(state.isVisible)
        .animation(reduceMotion ? nil : Motion.quick, value: state.isVisible)
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }
}
