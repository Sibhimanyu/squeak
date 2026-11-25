import AppKit
import SqueakMacCore
import SwiftUI

extension View {
    /// The one placement for every `@` and `/` suggestion list. The list is drawn inside the window (never an NSPopover, so the
    /// field keeps the keyboard), anchored to this view's edge: above it whenever the room is there (`SuggestionPlacement`),
    /// capped to the space and scrolling past that, never clipped. `selected` is scrolled into view.
    func suggestionPopup<Popup: View>(
        isPresented: Bool, direction: Binding<SuggestionPlacement.Direction>, selected: Int, @ViewBuilder _ popup: @escaping () -> Popup
    ) -> some View {
        modifier(SuggestionPopupModifier(isPresented: isPresented, direction: direction, selected: selected, popup: popup))
    }
}

private struct SuggestionPopupModifier<Popup: View>: ViewModifier {
    let isPresented: Bool
    @Binding var direction: SuggestionPlacement.Direction
    let selected: Int
    @ViewBuilder let popup: () -> Popup
    /// The anchor's frame in the window's top-level space, and the list's natural height.
    @State private var anchor: CGRect = .zero
    @State private var contentHeight: CGFloat = 0

    private var placement: SuggestionPlacement {
        let windowHeight = NSApp.keyWindow?.contentView?.bounds.height ?? anchor.maxY
        return .resolve(spaceAbove: anchor.minY, spaceBelow: windowHeight - anchor.maxY, contentHeight: contentHeight)
    }

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { anchor = $0 }
            .overlay(alignment: placement.direction == .up ? .topLeading : .bottomLeading) {
                if isPresented { list }
            }
            .onChange(of: placement.direction, initial: true) { _, new in direction = new }
    }

    private var list: some View {
        let p = placement
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        return ScrollViewReader { proxy in
            ScrollView {
                popup()
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .onChange(of: selected) { _, new in proxy.scrollTo(new, anchor: nil) }
        }
        .frame(height: contentHeight > 0 ? min(contentHeight, p.maxHeight) : 1)
        .background(Theme.surface, in: shape)
        .overlay(shape.strokeBorder(Theme.lineStrong))
        .clipShape(shape)
        .shadow(color: .black.opacity(0.35), radius: 14, y: p.direction == .up ? -6 : 6)
        .opacity(contentHeight > 0 ? 1 : 0)
        .alignmentGuide(p.direction == .up ? .top : .bottom) { d in
            p.direction == .up ? d[.bottom] + SuggestionPlacement.gap : d[.top] - SuggestionPlacement.gap
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestions")
    }
}
