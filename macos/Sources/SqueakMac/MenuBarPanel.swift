import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// What the `MenuBarExtra` window shows. The window is the system's, so this takes it over for the
/// panel's 24pt outer shape, and gives the model the one way to close it (Escape, a destination row).
struct MenuBarContent: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        PopoverView()
            .background(MenuWindowAccessor { window in
                model.dismissMenuBar = { [weak window] in window?.orderOut(nil) }
            })
    }
}

/// Clips the real menu window to `PopoverMetrics.corner`. `MenuBarExtra` gives its window the
/// system's own radius and material, so the window's backing is cleared and its layers are clipped
/// to our shape: the panel's material, its highlight and the window shadow (which follows alpha) then
/// share one outline. Public AppKit only; nothing here reads private view hierarchy by name.
struct MenuWindowAccessor: NSViewRepresentable {
    let onWindow: @MainActor (NSWindow) -> Void

    func makeNSView(context: Context) -> ShapeView {
        let view = ShapeView()
        view.onWindow = onWindow
        return view
    }

    func updateNSView(_ view: ShapeView, context: Context) {
        view.onWindow = onWindow
    }

    final class ShapeView: NSView {
        var onWindow: (@MainActor (NSWindow) -> Void)?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            Self.clip(window)
            onWindow?(window)
        }

        /// The system can rebuild its frame when the window is shown again, so clip on every layout too.
        override func layout() {
            super.layout()
            if let window { Self.clip(window) }
        }

        /// `MenuBarExtra` grows its window to the panel's tallest and never shrinks it back, so after a
        /// section folds the rounded panel floats inside a taller window, and the window's own material,
        /// square at its edges, shows above and below it. Shrink the window to the panel's height, keeping
        /// the top edge under the menu bar. Only ever shrinks: growing is the system's.
        static func fit(_ window: NSWindow) {
            guard let content = window.contentView else { return }
            let wanted = content.fittingSize.height
            let frameHeight = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 1, height: wanted)).height
            guard wanted > 120, wanted < 2_000, window.frame.height - frameHeight > 2 else { return }
            var frame = window.frame
            frame.origin.y = frame.maxY - frameHeight
            frame.size.height = frameHeight
            window.setFrame(frame, display: true)
            // The shadow is drawn from the window's alpha once; after a resize it is stale (a square shadow).
            window.invalidateShadow()
        }

        static func clip(_ window: NSWindow) {
            DispatchQueue.main.async { fit(window) }
            window.isOpaque = false
            window.backgroundColor = .clear
            window.invalidateShadow()
            let radius = PopoverMetrics.corner
            for view in [window.contentView?.superview, window.contentView].compactMap({ $0 }) {
                view.wantsLayer = true
                view.layer?.cornerRadius = radius
                view.layer?.cornerCurve = .continuous
                view.layer?.masksToBounds = true
            }
        }
    }
}

/// A section's heading in the menu: sentence case, muted, with its count and an optional trailing note
/// (the "new" count on Finished).
struct MenuSectionHeader: View {
    let title: String
    let count: Int
    var note: String?

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted)
            Text("\(count)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle)
            Spacer(minLength: Space.s)
            if let note {
                Text(verbatim: note).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.color(for: .finished))
            }
        }
        .padding(.horizontal, Space.l)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

/// One session in the menu, compact: a state dot, the headline and its age, `repo · agent`, and for a
/// finished or errored chat the start of its reply. Two lines otherwise, because the section heading
/// already says the state. Menu-only: the shared `SessionRowView` is not changed for it.
struct MenuSessionRow: View {
    let session: HostSession
    /// A reply excerpt (finished, errored) or a search snippet.
    var detail: String?
    var unread = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: Space.m) {
                // The state is said in words for VoiceOver (below); the dot is colour only.
                Circle().fill(Theme.color(for: session.state)).frame(width: 8, height: 8).padding(.top, 6)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: SessionText.headline(session))
                            .font(.system(size: 13, weight: unread ? .semibold : .medium))
                            .foregroundStyle(Theme.ink)
                            .lineLimit(1)
                        Spacer(minLength: Space.xs)
                        if unread {
                            Text("New").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.color(for: .finished))
                        }
                        RelativeTimeText(session.lastActivityAt, size: 12)
                    }
                    Text(verbatim: SessionText.secondLine(session))
                        .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    if let detail, !detail.isEmpty {
                        Text(verbatim: detail).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, Space.m)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.ink.opacity(hovering ? 0.09 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    /// Headline, `repo · agent`, the state word, the reply excerpt, and whether it is new, in full for VoiceOver.
    private var accessibilityText: String {
        var parts = [SessionText.headline(session), SessionText.secondLine(session), SessionText.stateWord(session)]
        if let detail, !detail.isEmpty { parts.append(detail) }
        if unread { parts.append("new") }
        return parts.filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// A band that opens in place: the header is a button whose chevron and accessibility value say whether
/// it is open. The body stays in the same scroll region, so the menu does not close.
struct MenuDisclosure<Content: View>: View {
    let title: String
    var count: Int?
    @Binding var expanded: Bool
    @ViewBuilder var content: Content
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button { expanded.toggle() } label: {
                HStack(spacing: Space.s) {
                    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                    if let count {
                        Text("\(count)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.muted)
                    }
                    Spacer(minLength: Space.s)
                    Lucide(expanded ? .chevronDown : .chevronRight, size: 14, color: Theme.muted)
                }
                .padding(.horizontal, Space.m)
                .padding(.vertical, 7)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.ink.opacity(hovering ? 0.09 : 0)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 4)
            .onHover { hovering = $0 }
            .accessibilityValue(expanded ? "expanded" : "collapsed")

            if expanded { content }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: expanded)
    }
}
