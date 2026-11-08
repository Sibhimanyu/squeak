#if os(iOS)
import SwiftUI

/// One neutral bar where text or a card will be. Still, not shimmering (DESIGN.md keeps motion for state).
struct SkeletonBar: View {
    let fraction: CGFloat
    let height: CGFloat

    var body: some View {
        // Full width, drawn shorter: the fraction is a visual scale, never a size taken from the container. Sized by
        // `containerRelativeFrame` inside Home's scroll view (the container's width then depends on the bar) it never
        // settled, and the launch placeholder kept a real iPhone in layout past the 20 s watchdog: 1.20.32 to 1.20.35
        // opened black. Reproduced on a simulator paired with the real Mac; demo data never shows this placeholder.
        RoundedRectangle(cornerRadius: 8).fill(Theme.surfaceRaised)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .scaleEffect(x: fraction, y: 1, anchor: .leading)
    }
}

/// What a screen shows the moment it opens, while what it reads from the Mac is on its way: neutral bars shaped
/// like the rows that will land, and one plain sentence saying what is happening. Used by every screen that waits.
struct SkeletonRows: View {
    /// What is being waited for, as the sentence under the bars ("Asking your Mac…").
    let word: String
    var rows = 3
    var rowHeight: CGFloat = 56

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(0..<rows, id: \.self) { i in
                SkeletonBar(fraction: i.isMultiple(of: 2) ? 1 : 0.85, height: rowHeight)
            }
            LoadingLine(word)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(word)
    }
}

/// A small inline spinner with a word.
struct LoadingLine: View {
    let word: String
    init(_ word: String) { self.word = word }

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(word).font(.footnote).foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .combine)
    }
}
#endif
