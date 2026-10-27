import SwiftUI

/// The popup's frame for every screen: a top part that never scrolls (header, tabs), a band that
/// scrolls, and an optional footer that stays on screen. The panel is as tall as its content needs, up
/// to `PopoverMetrics.maxHeight` or the screen less its margin, whichever is less: past that the band
/// scrolls, and a top part too tall for the cap scrolls inside itself, so the footer is never pushed off.
struct PopupScaffold<Top: View, Band: View, Footer: View>: View {
    var hasFooter = true
    var drawsOwnSurface = true
    var screenHeightOverride: CGFloat?
    @ViewBuilder var top: Top
    @ViewBuilder var band: Band
    @ViewBuilder var footer: Footer

    @State private var contentHeight: CGFloat = 0
    @State private var chromeHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    @State private var hostScreenHeight: CGFloat?

    private static var fallbackScreenHeight: CGFloat { 800 }
    private static var minBand: CGFloat { 96 }

    private var panelCap: CGFloat {
        let screen = screenHeightOverride ?? hostScreenHeight ?? Self.fallbackScreenHeight
        return max(0, min(PopoverMetrics.maxHeight, screen - PopoverMetrics.screenMargin))
    }

    private var footerTotal: CGFloat { hasFooter ? footerHeight : 0 }
    private var topCap: CGFloat { max(0, panelCap - footerTotal - Self.minBand) }
    private var topHeight: CGFloat? { chromeHeight > 0 ? min(chromeHeight, topCap) : nil }
    private var bandCap: CGFloat { max(0, panelCap - (topHeight ?? chromeHeight) - footerTotal) }
    private var bandHeight: CGFloat { min(max(contentHeight, Self.minBand), bandCap) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                top.padding(.horizontal, PopupMetrics.inset).measuredAsChrome()
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: topHeight)
            ScrollView(.vertical) {
                band.padding(.horizontal, PopupMetrics.inset).background(GeometryReader { Color.clear.preference(key: PopupBandHeightKey.self, value: $0.size.height) })
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.automatic)
            .onPreferenceChange(PopupBandHeightKey.self) { contentHeight = $0 }
            .frame(height: bandHeight)
            if hasFooter { footer.padding(.horizontal, PopupMetrics.inset).measuredAsFooter() }
        }
        .frame(width: PopoverMetrics.width)
        .background(ScreenHeightReader { hostScreenHeight = $0 })
        .modifier(PopupSurface(enabled: drawsOwnSurface))
        .onPreferenceChange(PopoverChromeKey.self) { chromeHeight = $0 }
        .onPreferenceChange(PopoverFooterKey.self) { footerHeight = $0 }
    }
}

extension PopupScaffold where Footer == EmptyView {
    init(drawsOwnSurface: Bool = true, screenHeightOverride: CGFloat? = nil,
         @ViewBuilder top: () -> Top, @ViewBuilder band: () -> Band) {
        self.init(hasFooter: false, drawsOwnSurface: drawsOwnSurface, screenHeightOverride: screenHeightOverride,
                  top: top, band: band, footer: { EmptyView() })
    }
}

private struct PopupBandHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

private struct PopupSurface: ViewModifier {
    let enabled: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if enabled { content.panelSurface() } else { content }
    }
}
