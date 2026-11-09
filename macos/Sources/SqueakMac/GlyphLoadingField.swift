import SqueakIcons
import SwiftUI

/// A flowing pixel matrix behind running tabs and worktrees. The foreground title remains sharp.
struct GlyphLoadingField: View {
    var body: some View {
        MatrixActivity(style: .field, color: Theme.muted).blur(radius: 0.25)
    }
}
