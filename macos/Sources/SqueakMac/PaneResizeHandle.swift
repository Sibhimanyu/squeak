import AppKit
import SqueakMacCore
import SwiftUI

/// DESIGN.md §8.10: a pane's drag handle. A `Tokens.Divider.hit` hit area on the pane's inner edge with no visible grip: the `line`
/// hairline shows a touch stronger (`line-strong`) while the pointer is over it or it is dragged, and the cursor says
/// "resize". The width follows where the drag started plus the distance moved, in window coordinates, so the handle
/// moving under the pointer cannot feed back and nothing jumps. A double click returns the pane to its default.
/// The one look every split divider shares (sidebar, inspector, terminal): a `Tokens.Divider.thickness` line in `line`
/// (or nothing at rest when the pane already draws its own edge), `line-strong` while hovered or dragged, and the resize
/// cursor over the whole `Tokens.Divider.hit` area.
struct SplitDividerLine: View {
    let vertical: Bool          // a vertical line splits left from right
    let hovering: Bool
    let dragging: Bool
    var drawsAtRest = true

    var body: some View {
        let on = hovering || dragging
        Rectangle().fill(on ? Theme.lineStrong : (drawsAtRest ? Theme.line : Color.clear))
            .frame(width: vertical ? Tokens.Divider.thickness : nil, height: vertical ? nil : Tokens.Divider.thickness)
            .allowsHitTesting(false)
    }
}

extension View {
    /// Resize cursor over the hit area; tracks hover into `hovering` and restores the arrow when the pointer leaves or
    /// the view goes away.
    func splitDividerCursor(_ cursor: NSCursor, hovering: Binding<Bool>) -> some View {
        self
            .onContinuousHover { phase in
                switch phase {
                case .active: hovering.wrappedValue = true; cursor.set()
                case .ended: hovering.wrappedValue = false; NSCursor.arrow.set()
                }
            }
            .onDisappear { if hovering.wrappedValue { NSCursor.arrow.set(); hovering.wrappedValue = false } }
    }
}

struct PaneResizeHandle: View {
    enum Edge { case trailing, leading }
    let edge: Edge
    @Binding var width: Double
    let range: ClosedRange<Double>
    let fallback: Double
    let window: Double
    let otherPane: Double
    @State private var start: Double?
    @State private var hovering = false

    var body: some View {
        Rectangle().fill(Color.clear)
            .frame(width: Tokens.Divider.hit)
            .contentShape(Rectangle())
            .overlay(alignment: edge == .trailing ? .trailing : .leading) {
                // The pane draws its own edge at rest; the handle only brightens it.
                SplitDividerLine(vertical: true, hovering: hovering, dragging: start != nil, drawsAtRest: false)
            }
            .splitDividerCursor(.resizeLeftRight, hovering: $hovering)
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { value in
                        let from = start ?? (width > 0 ? width : fallback)
                        start = from
                        width = PaneWidths.dragged(
                            start: from, translation: value.translation.width, grewToward: edge == .trailing ? 1 : -1,
                            range: range, window: window, otherPane: otherPane)
                    }
                    .onEnded { _ in start = nil }
            )
            .onTapGesture(count: 2) { width = fallback }
            .accessibilityElement()
            .accessibilityLabel(edge == .trailing ? "Resize sidebar" : "Resize inspector")
            .accessibilityValue("\(Int(width > 0 ? width : fallback)) points")
            .accessibilityAdjustableAction { direction in
                let step = direction == .increment ? 16.0 : -16.0
                width = PaneWidths.dragged(start: width > 0 ? width : fallback, translation: step, grewToward: 1, range: range, window: window, otherPane: otherPane)
            }
    }
}
