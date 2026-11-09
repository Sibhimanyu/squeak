import AppKit
import SqueakMacCore
import SwiftUI

/// DESIGN.md §8.10: a pane's drag handle. A 4pt hit area on the pane's inner edge with no visible grip: the `line`
/// hairline shows a touch stronger (`line-strong`) while the pointer is over it or it is dragged, and the cursor says
/// "resize". The width follows where the drag started plus the distance moved, in window coordinates, so the handle
/// moving under the pointer cannot feed back and nothing jumps. A double click returns the pane to its default.
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
            .frame(width: 4)
            .contentShape(Rectangle())
            .overlay(alignment: edge == .trailing ? .trailing : .leading) {
                Rectangle().fill(hovering || start != nil ? Theme.lineStrong : Color.clear).frame(width: 1)
            }
            .onHover { inside in
                hovering = inside
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .onDisappear { if hovering { NSCursor.pop(); hovering = false } }
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
