import AppKit
import SqueakIcons
import SwiftUI

/// Lucide as a template `Image`, for the few places that only take an image (Settings tab items).
/// Everywhere else use the `Lucide` view directly.
@MainActor
enum LucideImage {
    static func template(_ name: LucideName, size: CGFloat = 20) -> Image {
        let renderer = ImageRenderer(content: Lucide(name, size: size, color: Color.black).frame(width: size, height: size))
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        guard let image = renderer.nsImage else { return Image(nsImage: NSImage(size: NSSize(width: size, height: size))) }
        image.isTemplate = true
        return Image(nsImage: image)
    }
}

/// `Label` with a Lucide icon (sidebar rows, tab items).
struct LucideLabel: View {
    let title: String
    let name: LucideName
    var size: CGFloat = 16
    var color: Color? = nil

    init(_ title: String, _ name: LucideName, size: CGFloat = 16, color: Color? = nil) {
        self.title = title; self.name = name; self.size = size; self.color = color
    }

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Lucide(name, size: size, color: color ?? Theme.muted)
        }
    }
}
