import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// New layout (DESIGN.md 8.12, stage 3): the line under a finished turn is a quiet actions row directly under the message's
/// last line, left-aligned with the text: small icon buttons (Copy, "..." for Copy whole turn) and the muted duration and
/// time. It is drawn on hover or keyboard focus (and at rest on the newest reply) but always owns its height, so it never
/// covers text and showing it never moves a row. It stays in the view tree at zero opacity so Tab reaches Copy (and
/// VoiceOver reads it) without a pointer. Placement and visibility are `MessageActionBarState`.
struct MessageActionBar: View {
    let footer: TurnFooter
    /// This message's own text, for the Copy button.
    let messageText: String
    /// The pointer is over the message itself.
    let overMessage: Bool
    var isNewest = false
    @State private var overBar = false
    @State private var copied = false
    @FocusState private var focus: Control?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum Control: Hashable { case copy, more }

    private var state: MessageActionBarState {
        MessageActionBarState(hovering: overMessage || overBar, focusWithin: focus != nil, isNewest: isNewest)
    }

    var body: some View {
        HStack(spacing: 2) {
            Button { copy(messageText) } label: {
                Lucide(copied ? .check : .copy, size: 14, color: copied ? Theme.ink : Theme.muted)
                    .frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand().focused($focus, equals: .copy)
            .help(copied ? "Copied" : "Copy this message").accessibilityLabel("Copy this message")
            SqueakMenu {
                Button("Copy whole turn") { copy(footer.turnText) }
            } label: {
                Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().pointerHand().focused($focus, equals: .more)
            .help("More").accessibilityLabel("More")
            let line = footer.line { $0.formatted(date: .omitted, time: .shortened) }
            if !line.isEmpty {
                Text(verbatim: line).font(Typo.footnote).monospacedDigit().foregroundStyle(Theme.muted)
                    .lineLimit(1).fixedSize().padding(.leading, 6)
            }
        }
        .frame(height: CGFloat(MessageActionBarState.reservedHeight), alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
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
