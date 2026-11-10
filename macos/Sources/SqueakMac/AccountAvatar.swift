import AppKit
import SqueakMacCore
import SwiftUI

/// The account's photo, else the initial in a circle.
struct AccountAvatar: View {
    let image: NSImage?
    let email: String
    var size: CGFloat = 28

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                ZStack {
                    Color(Theme.selectedStrong)
                    Text(MacSwitcherMenu.initial(of: email)).font(.system(size: size * 0.46, weight: .semibold)).foregroundStyle(Theme.ink)
                }
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Your photo")
    }

    /// A rounded copy for a native menu item's image.
    static func menuImage(_ image: NSImage, size: CGFloat = 18) -> NSImage {
        let out = NSImage(size: NSSize(width: size, height: size), flipped: false) { r in
            NSBezierPath(ovalIn: r).addClip()
            image.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1)
            return true
        }
        return out
    }
}
