import AppKit
import SwiftUI

// The pointing hand over anything clickable that SwiftUI draws (a plain button shows the arrow). Text links are runs in an
// NSTextView, which shows the hand itself (SelectableText.swift in SqueakMarkup).

extension View {
    /// The pointing hand while the pointer is over this view: `pointerStyle(.link)` on macOS 15, a cursor push/pop on 14.
    @ViewBuilder func pointerHand(_ enabled: Bool = true) -> some View {
        if !enabled {
            self
        } else if #available(macOS 15, *) {
            self.pointerStyle(.link)
        } else {
            modifier(HandCursor())
        }
    }
}

private struct HandCursor: ViewModifier {
    @State private var inside = false

    func body(content: Content) -> some View {
        content
            .onHover { hovering in
                if hovering, !inside { NSCursor.pointingHand.push(); inside = true }
                else if !hovering, inside { NSCursor.pop(); inside = false }
            }
            .onDisappear { if inside { NSCursor.pop(); inside = false } }
    }
}
