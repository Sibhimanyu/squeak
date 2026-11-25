import AppKit
import SqueakMacCore
import SwiftUI

extension View {
    /// The one placement for every `@` and `/` suggestion list. A compact popover drawn inside the window (never an NSPopover,
    /// so the field keeps the keyboard), attached to this view, which must be the field's box: its bottom edge a few points
    /// above the box's top border so the typed text stays visible, its left edge at the trigger character (`triggerX`, in
    /// window x; nil starts at the left), clamped inside the box. `SuggestionPlacement` decides; the list shows at most six
    /// rows of `rowHeight`, then scrolls. `selected` is scrolled into view.
    func suggestionPopup<Popup: View>(
        isPresented: Bool, direction: Binding<SuggestionPlacement.Direction>, selected: Int, triggerX: CGFloat? = nil,
        rowHeight: CGFloat = 28, @ViewBuilder _ popup: @escaping () -> Popup
    ) -> some View {
        modifier(SuggestionPopupModifier(
            isPresented: isPresented, direction: direction, selected: selected, triggerX: triggerX, rowHeight: rowHeight, popup: popup))
    }
}

private struct SuggestionPopupModifier<Popup: View>: ViewModifier {
    let isPresented: Bool
    @Binding var direction: SuggestionPlacement.Direction
    let selected: Int
    let triggerX: CGFloat?
    let rowHeight: CGFloat
    @ViewBuilder let popup: () -> Popup
    /// The anchor's frame in the window's top-level space, and the list's natural height.
    @State private var anchor: CGRect = .zero
    @State private var contentHeight: CGFloat = 0

    private var placement: SuggestionPlacement {
        let windowHeight = NSApp.keyWindow?.contentView?.bounds.height ?? anchor.maxY
        return .resolve(
            spaceAbove: anchor.minY, spaceBelow: windowHeight - anchor.maxY, contentHeight: contentHeight,
            cap: SuggestionPlacement.heightCap(rowHeight: rowHeight, padding: 8))
    }

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { anchor = $0 }
            .overlay(alignment: .topLeading) {
                if isPresented { list }
            }
            .onChange(of: placement.direction, initial: true) { _, new in direction = new }
    }

    private var list: some View {
        let p = placement
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        let width = SuggestionPlacement.width(anchorWidth: anchor.width)
        let height = contentHeight > 0 ? min(contentHeight, p.maxHeight) : 1
        let origin = SuggestionPlacement.origin(
            direction: p.direction, triggerX: triggerX.map { $0 - anchor.minX }, anchorSize: anchor.size,
            popupSize: CGSize(width: width, height: height))
        return ScrollViewReader { proxy in
            ScrollView {
                popup()
                    .frame(width: width, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .onChange(of: selected) { _, new in proxy.scrollTo(new, anchor: nil) }
        }
        .frame(width: width, height: height)
        .background(Theme.surface, in: shape)
        .overlay(shape.strokeBorder(Theme.lineStrong))
        .clipShape(shape)
        .shadow(color: .black.opacity(0.35), radius: 14, y: p.direction == .up ? -6 : 6)
        .opacity(contentHeight > 0 ? 1 : 0)
        .offset(x: origin.x, y: origin.y)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestions")
    }
}
