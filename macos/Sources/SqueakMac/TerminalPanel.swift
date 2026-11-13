import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftTerm
import SwiftUI

/// DESIGN.md §8.10, the terminal panel: the bottom of the centre column, ⌘J. A hairline drag handle on top, a 32pt
/// strip of tabs (one shell each; + or ⌘T while the terminal has focus adds one; each tab's × ends its shell), then
/// the terminal. One set of tabs per workspace folder, kept alive while the app runs; hiding the panel only hides it.
struct TerminalPanel: View {
    let session: HostSession
    let column: Double
    @Binding var height: Double
    @Binding var open: Bool
    /// Inside the inspector's lower part: no height of its own, no drag handle, no hide button (the part has them).
    var embedded = false
    private let host = TerminalHost.shared
    @Environment(\.colorScheme) private var scheme
    @State private var dragStart: Double?
    @State private var hovering = false

    private var availability: TerminalWorkspace.Availability { TerminalWorkspace.availability(cwd: session.cwd) }
    private var workspace: String? { availability.folder }
    private var shown: Double { TerminalPanelSizing.clamp(height, column: column) }

    var body: some View {
        VStack(spacing: 0) {
            if case .available(let folder) = availability, let code = host.stopped[folder],
               TerminalPlan.showsStopped(hasTabs: !host.registry.tabs(folder).isEmpty, guardStopped: true) {
                if !embedded { strip(folder: folder) }
                VStack(spacing: Space.m) {
                    Text(verbatim: TerminalPlan.stoppedMessage(exitCode: code)).font(Typo.body).foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                    Button("Start a new shell") { host.ensure(workspace: folder, folder: folder); host.focusPending = true }
                }
                .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case .available(let folder) = availability {
                // Embedded, the inspector's row carries the shell tabs.
                if !embedded { strip(folder: folder) }
                // Reading the selected tab here makes the panel redraw when a tab is added, replaced or ended, embedded or not.
                TerminalSurface(workspace: folder, tab: host.registry.selected(folder)?.id, dark: scheme == .dark)
                    .id(folder)
                    .padding(.leading, Space.s).padding(.top, Space.xs)
                    .background(Color(nsColor: NSColor(hex: (scheme == .dark ? Tokens.Terminal.dark : Tokens.Terminal.light).background)))
            } else if case .unavailable(let reason) = availability {
                strip(folder: nil)
                Text(verbatim: reason).font(Typo.body).foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center).padding(Space.l)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .modifier(PanelFrame(embedded: embedded, height: shown))
        .background(Theme.bg)
        .overlay(alignment: .top) { if !embedded { handle } }
        .overlay(alignment: .top) { if !embedded { Rectangle().fill(KeyFocus.shared.terminalFocused ? Theme.lineStrong : Theme.line).frame(height: 1).allowsHitTesting(false) } }
        .task(id: workspace) {
            if let folder = workspace { host.ensure(workspace: folder, folder: folder) }
        }
        .onAppear { if let folder = workspace { host.ensure(workspace: folder, folder: folder) } }
        .overlay { FocusEdge(active: KeyFocus.shared.terminalFocused) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Terminal")
    }

    /// The hit area over the panel's top edge; the hairline goes `line-strong` under the pointer or a drag.
    private var handle: some View {
        Rectangle().fill(Color.clear).frame(height: 8).contentShape(Rectangle())
            .overlay(alignment: .top) { Rectangle().fill(hovering || dragStart != nil ? Theme.lineStrong : Color.clear).frame(height: 1).allowsHitTesting(false) }
            .onContinuousHover { phase in
                switch phase {
                case .active: hovering = true; NSCursor.resizeUpDown.set()
                case .ended: hovering = false; NSCursor.arrow.set()
                }
            }
            .onDisappear { if hovering { NSCursor.arrow.set(); hovering = false } }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { v in
                        let from = dragStart ?? shown
                        dragStart = from
                        height = TerminalPanelSizing.dragged(start: from, translation: v.translation.height, column: column)
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .onTapGesture(count: 2) { height = TerminalPanelSizing.defaultHeight }
            .accessibilityElement()
            .accessibilityLabel("Resize terminal")
            .accessibilityValue("\(Int(shown)) points")
            .accessibilityAdjustableAction { d in
                height = TerminalPanelSizing.clamp(shown + (d == .increment ? 16 : -16), column: column)
            }
    }

    private func strip(folder: String?) -> some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    if let folder {
                        ForEach(host.registry.tabs(folder)) { tab in
                            TerminalTabButton(
                                title: host.title(of: tab), selected: host.registry.selected(folder)?.id == tab.id,
                                select: { host.select(workspace: folder, tab.id) },
                                close: { host.requestClose(workspace: folder, tab.id) })
                        }
                    } else {
                        Text("Terminal").font(Typo.label).foregroundStyle(Theme.muted).padding(.horizontal, Space.s)
                    }
                }
                .padding(.horizontal, Space.m)
            }
            if let folder {
                Button { host.add(workspace: folder, folder: folder) } label: {
                    Lucide(.plus, size: Metrics.iconSmall, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help(ShortcutFocus.newTerminalHint(in: KeyFocus.shared.region, terminalOpen: KeyFocus.shared.terminalOpen).replacingOccurrences(of: "  ", with: " ")).accessibilityLabel("New terminal")
            }
            if !embedded {
                Button { open = false } label: {
                    Lucide(.x, size: Metrics.iconSmall, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).padding(.trailing, Space.m).help("Hide terminal (⌘J)").accessibilityLabel("Hide terminal")
            }
        }
        .frame(height: CGFloat(Tokens.Workbench.terminalTabHeight))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

private struct PanelFrame: ViewModifier {
    let embedded: Bool
    let height: Double
    func body(content: Content) -> some View {
        if embedded { content.frame(maxWidth: .infinity, maxHeight: .infinity) } else { content.frame(height: height) }
    }
}

private struct TerminalTabButton: View {
    let title: String
    let selected: Bool
    let select: () -> Void
    let close: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: title).font(Typo.code).lineLimit(1).truncationMode(.tail)
                .foregroundStyle(selected ? Theme.ink : Theme.muted)
            Button(action: close) {
                Lucide(.x, size: 11, color: Theme.muted).frame(width: 16, height: 16).contentShape(Rectangle())
            }
            .buttonStyle(.plain).opacity(selected || hovering ? 1 : 0).accessibilityLabel("Close \(title)").help("Close this terminal")
        }
        .padding(.leading, 10).padding(.trailing, 4)
        .frame(height: 24).frame(maxWidth: 200)
        .background(RoundedRectangle(cornerRadius: Radius.control).fill(selected ? Theme.selected : (hovering ? Theme.selected.opacity(0.5) : .clear)))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: select)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction(named: "Close", close)
    }
}

/// Hosts the selected tab's SwiftTerm view; the views themselves belong to `TerminalHost`.
private struct TerminalSurface: NSViewRepresentable {
    private let host = TerminalHost.shared
    let workspace: String
    /// The selected tab; unused except that a change re-runs `updateNSView`.
    let tab: UUID?
    let dark: Bool

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        v.wantsLayer = true
        return v
    }

    func updateNSView(_ container: NSView, context: Context) {
        let wanted = host.registry.selected(workspace).flatMap { host.view(for: $0.id) }
        if let wanted {
            TerminalStyle.apply(to: wanted, dark: dark)
            if wanted.superview !== container {
                container.subviews.forEach { $0.removeFromSuperview() }
                wanted.frame = container.bounds
                wanted.autoresizingMask = [.width, .height]
                container.addSubview(wanted)
            }
            // Real size at first draw: the container may have been laid out after the view was created.
            if wanted.frame != container.bounds { wanted.frame = container.bounds }
            wanted.needsLayout = true
            wanted.needsDisplay = true
            if host.focusPending {
                host.focusPending = false
                DispatchQueue.main.async { wanted.window?.makeFirstResponder(wanted) }
            }
        } else {
            container.subviews.forEach { $0.removeFromSuperview() }
        }
    }
}

/// The terminal holds the keys: a quiet 1pt neutral inner border (`line-strong`), nothing while it does not.
struct FocusEdge: View {
    let active: Bool
    var body: some View {
        Rectangle().strokeBorder(Theme.lineStrong, lineWidth: 1).opacity(active ? 1 : 0)
            .allowsHitTesting(false).animation(Motion.standard, value: active)
            .accessibilityHidden(true)
    }
}
