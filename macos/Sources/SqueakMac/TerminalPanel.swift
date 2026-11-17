import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftTerm
import SwiftUI

/// DESIGN.md §8.10, the terminal panel: one shell, by id, filling whatever dock zone shows it. Each shell is its own tab
/// in a zone's strip (`DockTerminalTab`), so there is no row of shell tabs in here. The shells belong to `TerminalHost`
/// (one set per workspace folder, kept alive while the app runs): moving a tab between zones or hiding the zone only
/// moves or detaches the view, never the process. `shell` nil shows the folder's selected shell, starting one on first use.
struct TerminalPanel: View {
    let session: HostSession
    var shell: UUID?
    private let host = TerminalHost.shared
    @Environment(\.colorScheme) private var scheme

    private var availability: TerminalWorkspace.Availability { TerminalWorkspace.availability(cwd: session.cwd) }
    private var workspace: String? { availability.folder }

    var body: some View {
        VStack(spacing: 0) {
            if case .available(let folder) = availability, let code = host.stopped[folder],
               TerminalPlan.showsStopped(hasTabs: !host.registry.tabs(folder).isEmpty, guardStopped: true) {
                VStack(spacing: Space.m) {
                    Text(verbatim: TerminalPlan.stoppedMessage(exitCode: code)).font(Typo.body).foregroundStyle(Theme.muted)
                        .multilineTextAlignment(.center)
                    Button("Start a new shell") { NewTerminalAction.open(folder: folder) }
                }
                .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case .available(let folder) = availability {
                // Reading the shown tab here makes the panel redraw when a shell is added, replaced or ended.
                TerminalSurface(workspace: folder, tab: shell ?? host.registry.selected(folder)?.id, dark: scheme == .dark)
                    .padding(.leading, Space.s).padding(.top, Space.xs)
                    .background(Color(nsColor: NSColor(hex: (scheme == .dark ? Tokens.Terminal.dark : Tokens.Terminal.light).background)))
            } else if case .unavailable(let reason) = availability {
                Text(verbatim: reason).font(Typo.body).foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center).padding(Space.l)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task(id: workspace) {
            if shell == nil, let folder = workspace { host.ensure(workspace: folder, folder: folder) }
        }
        .onAppear { if shell == nil, let folder = workspace { host.ensure(workspace: folder, folder: folder) } }
        .overlay { FocusEdge(active: KeyFocus.shared.terminalFocused) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Terminal")
    }
}

/// The shell's view outlives its container (it belongs to `TerminalHost`), so when the zone moves between placements
/// the new container takes the same view over: keep it filling the container and repaint it once it is in a window.
private final class TerminalContainer: NSView {
    override func layout() {
        super.layout()
        for v in subviews where v.frame != bounds { v.frame = bounds }
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        subviews.forEach { $0.needsLayout = true; $0.needsDisplay = true }
    }
}

/// Hosts the selected tab's SwiftTerm view; the views themselves belong to `TerminalHost`.
private struct TerminalSurface: NSViewRepresentable {
    private let host = TerminalHost.shared
    let workspace: String
    /// The shell to show (nil = the folder's selected one); a change re-runs `updateNSView`.
    let tab: UUID?
    let dark: Bool

    func makeNSView(context: Context) -> NSView {
        let v = TerminalContainer()
        v.wantsLayer = true
        return v
    }

    func updateNSView(_ container: NSView, context: Context) {
        let wanted = tab.flatMap { host.view(for: $0) } ?? host.registry.selected(workspace).flatMap { host.view(for: $0.id) }
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
