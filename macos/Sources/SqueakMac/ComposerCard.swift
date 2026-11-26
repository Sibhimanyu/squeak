import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The unified composer card (DESIGN.md §8.12, Direction A, owner's pick 2026-11-26): one `surface` card, `radius-panel`,
/// in three bands. At the top the status line (only while something runs; the slot draws its own band, `ComposerStatusBand`),
/// then anything attached (images, a quote), then the text, which grows a line at a time up to eight and then scrolls inside
/// (`ComposerDesign.fieldHeight`), and at the bottom one fixed 36pt toolbar: what you choose before you send at the left,
/// then the context, dictation and Send at the right. The toolbar is pinned to the card's bottom edge, so no icon moves
/// while the text grows. The chat's, the Room's and New duck's composers all use it.
struct ComposerCard<Status: View, Top: View, Field: View, Leading: View, Trailing: View>: View {
    /// The field has the keyboard: the pond's accent rings the card (§3.5); with no pond, a stronger hairline.
    var focused = false
    var pondId: String?
    @ViewBuilder var status: () -> Status
    @ViewBuilder var top: () -> Top
    @ViewBuilder var field: () -> Field
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    static var toolbarHeight: CGFloat { 36 }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.panel, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            status()
            VStack(alignment: .leading, spacing: 6) {
                top()
                field()
            }
            // The field's own inset (4 + the line padding 5) brings the text to 15pt from the edge.
            .padding(.horizontal, 6).padding(.top, 8)
            HStack(spacing: 2) {
                leading()
                Spacer(minLength: 8)
                trailing()
            }
            .frame(height: Self.toolbarHeight)
            .padding(.horizontal, 8).padding(.bottom, 6)
        }
        .background(Theme.surface, in: shape)
        .overlay(shape.strokeBorder(focused && pondId == nil ? Theme.lineStrong : Theme.lineStrong.opacity(0.8)))
        .overlay {
            if focused, pondId != nil {
                shape.strokeBorder(PondColour.focusRing(pondId), lineWidth: 1.5).allowsHitTesting(false).transition(.opacity)
            }
        }
        .animation(Motion.quick, value: focused)
    }
}

/// The status band at the card's top edge: 34pt, the content inset 12, a hairline under it.
struct ComposerStatusBand<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                content()
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).frame(height: 34)
            Rectangle().fill(Theme.line).frame(height: 1)
        }
    }
}

/// The thin divider between the tools (attach, @, /) and the choices (model, mode) in the toolbar.
struct ComposerToolbarDivider: View {
    var body: some View { Rectangle().fill(Theme.line).frame(width: 1, height: 16).padding(.horizontal, 6).accessibilityHidden(true) }
}

/// A choice in the toolbar (the model picker, who a Room message goes to, New duck's agent): `selected` fill, `radius-control`,
/// 28pt, the same height as the mode chip beside it.
struct ComposerToolbarChip<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .frame(height: 28)
            .background(Theme.selected, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
}

/// `@` and `/` in the toolbar: insert the trigger and open its list.
struct ComposerTriggerButton: View {
    let mark: String
    let label: String
    let help: String
    var enabled = true
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(verbatim: mark).font(.system(size: 15, weight: .medium, design: .rounded)).foregroundStyle(enabled ? Theme.muted : Theme.subtle)
                .frame(width: 28, height: 28).contentShape(Circle())
        }
        .buttonStyle(.plain).pointerHand(enabled).disabled(!enabled)
        .help(help).accessibilityLabel(label)
    }
}

/// The hint beside Send while the agent works: "Steers now · ⌘↩ to queue".
struct ComposerSendHint: View {
    let text: String
    var body: some View {
        Text(verbatim: text).font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
            .padding(.trailing, 4).transition(.opacity)
    }
}

/// The text area's frame: whole 22pt lines from `minLines` to eight, then the field scrolls inside.
struct ComposerFieldFrame: ViewModifier {
    let content: CGFloat
    var minLines = 1
    func body(content view: Content) -> some View {
        let g = ComposerDesign.fieldHeight(content: content, minLines: minLines)
        view.frame(height: g.height)
            // Past eight lines it scrolls: the lines cut by the top and bottom edges fade, so none reads as clipped.
            .mask {
                if g.scrolls {
                    LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 6 / g.height),
                                           .init(color: .black, location: 1 - 8 / g.height), .init(color: .clear, location: 1)],
                                   startPoint: .top, endPoint: .bottom)
                } else {
                    Rectangle()
                }
            }
    }
}

extension View {
    func composerFieldFrame(_ contentHeight: CGFloat, minLines: Int = 1) -> some View {
        modifier(ComposerFieldFrame(content: contentHeight, minLines: minLines))
    }
}
