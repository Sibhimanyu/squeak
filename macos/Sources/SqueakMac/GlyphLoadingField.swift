import SqueakIcons
import SwiftUI

/// A flowing pixel matrix behind running tabs and worktrees. The foreground title remains sharp.
struct GlyphLoadingField: View {
    var body: some View {
        MatrixActivity(style: .field, color: Theme.muted).blur(radius: 0.25)
    }
}

/// A chat tab keeps activity beside its title, preserving both its name and provider marker.
struct ChatTabActivity: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        MatrixActivity(style: .indicator, color: colorScheme == .dark ? .white : .black,
                       still: scenePhase != .active)
            .frame(width: 64, height: 20)
            .fixedSize()
            .accessibilityHidden(true)
    }
}
