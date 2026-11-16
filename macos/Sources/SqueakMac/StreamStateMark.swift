import SqueakIcons
import SqueakMacCore
import SwiftUI

/// A stream's state as one mark (DESIGN.md §8.1): working is the tide glyph in `working`, waiting an amber dot (never
/// a count), failed the circle-x in `negative`, unread a `done` dot, idle nothing. The slot keeps its size in every
/// state, so a row never moves. The state comes from the daemon's data (`StreamGlyphState`); this only draws it.
struct StreamStateMark: View {
    let state: StreamGlyphState
    /// The slot's width; the working glyph is drawn larger than it and fades out at its edges.
    var slotWidth: CGFloat = 20
    /// The stream's name; when given the mark speaks "name, working", otherwise it is decoration.
    var name: String? = nil

    var body: some View {
        ZStack {
            switch state {
            case .working: WorkingGlyph(height: slotWidth >= 20 ? 15 : 12, slot: slotWidth, alignment: .center, grid: .compact)
            case .waiting: StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16)
            case .failed: StatusMark(kind: .failed, color: Theme.negative, size: 14)
            case .unread: StatusMark(kind: .unread, color: Theme.done, size: 18)
            case .idle: Color.clear
            }
        }
        .frame(width: slotWidth, height: 16)
        .modifier(StreamStateSpeech(name: name, state: state))
    }
}

private struct StreamStateSpeech: ViewModifier {
    let name: String?
    let state: StreamGlyphState

    func body(content: Content) -> some View {
        if let name {
            content.accessibilityElement().accessibilityLabel(state.label(for: name))
        } else {
            content.accessibilityHidden(true)
        }
    }
}
