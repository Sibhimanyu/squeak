import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Sidebar

/// The window's left column, drawn by hand to the mockup: a brand line, a search field with a ⌘K hint,
/// 36pt line-icon rows (a count, or a red badge for what needs you), a SOURCES group, and the
/// connection and Settings at the foot. Selection is `model.navFilter`.
extension View {
    /// Content and the native divider share a short, non-bouncing ease curve. The native
    /// sizer owns its clock: SwiftUI can coalesce representable updates during animation.
    func sidebarColumn(
        isCollapsed: Bool,
        expandedMinimum: CGFloat,
        expandedIdeal: CGFloat,
        expandedMaximum: CGFloat,
        reduceMotion: Bool
    ) -> some View {
        let width = isCollapsed ? 64 : expandedIdeal
        return self
            .lineLimit(1)
            .frame(width: width, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .clipped()
            .background(SidebarBackground())
            .animation(reduceMotion ? nil : .timingCurve(1.0 / 3, 0, 2.0 / 3, 1, duration: SidebarColumnSizerView.duration), value: isCollapsed)
            // Keep SwiftUI's native preference permissive while the sizer interpolates
            // the actual constraints. A target-only minimum would snap the divider.
            .navigationSplitViewColumnWidth(min: 64, ideal: width, max: expandedMaximum)
            .background {
                SidebarColumnSizer(
                    configuration: .init(
                        minimum: isCollapsed ? 64 : expandedMinimum,
                        ideal: width,
                        maximum: isCollapsed ? 64 : expandedMaximum
                    ),
                    animated: !reduceMotion
                )
                .frame(width: 0, height: 0)
            }
    }
}

/// NavigationSplitView assigns its native sidebar a 140pt minimum. Enforce the
/// current animated constraints synchronously so that minimum never flashes onscreen.
struct SidebarColumnSizer: NSViewRepresentable {
    let configuration: SidebarColumnSizerView.Configuration
    let animated: Bool

    func makeNSView(context: Context) -> SidebarColumnSizerView {
        SidebarColumnSizerView(configuration: configuration)
    }

    func updateNSView(_ view: SidebarColumnSizerView, context: Context) {
        view.setConfiguration(configuration, animated: animated)
    }
}

@MainActor
final class SidebarColumnSizerView: NSView {
    struct Configuration: Equatable {
        let minimum: CGFloat
        let ideal: CGFloat
        let maximum: CGFloat
    }

    static let duration: TimeInterval = 0.24
    private(set) var configuration: Configuration
    private var destination: Configuration
    private var animationTimer: Timer?
    private var animationStart: TimeInterval = 0
    private var animationOrigin: Configuration
    private var applyScheduled = false
    private var isApplying = false
    private weak var observedSplitView: NSSplitView?

    init(configuration: Configuration) {
        self.configuration = configuration
        self.destination = configuration
        self.animationOrigin = configuration
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            animationTimer?.invalidate()
            animationTimer = nil
            configuration = destination
        }
        applyWhenAttached()
    }

    func setConfiguration(_ target: Configuration, animated: Bool) {
        guard target != destination else {
            if !animated, animationTimer != nil {
                animationTimer?.invalidate()
                animationTimer = nil
                configuration = target
            }
            applyWhenAttached()
            return
        }
        destination = target
        animationTimer?.invalidate()
        animationTimer = nil
        guard animated, window != nil, splitViewController != nil else {
            configuration = target
            applyWhenAttached()
            return
        }
        animationOrigin = configuration
        animationStart = ProcessInfo.processInfo.systemUptime
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.advanceAnimation() }
        }
        animationTimer = timer
        RunLoop.main.add(timer, forMode: .common)
        advanceAnimation()
    }

    private func advanceAnimation() {
        let elapsed = ProcessInfo.processInfo.systemUptime - animationStart
        let progress = min(max(elapsed / Self.duration, 0), 1)
        // With x control points at 1/3 and 2/3, the matching SwiftUI cubic
        // has x(t) = t and y(t) = 3t² - 2t³.
        let fraction = progress * progress * (3 - 2 * progress)
        func interpolate(_ from: CGFloat, _ to: CGFloat) -> CGFloat { from + (to - from) * fraction }
        configuration = .init(
            minimum: interpolate(animationOrigin.minimum, destination.minimum),
            ideal: interpolate(animationOrigin.ideal, destination.ideal),
            maximum: interpolate(animationOrigin.maximum, destination.maximum)
        )
        apply()
        if progress >= 1 {
            animationTimer?.invalidate()
            animationTimer = nil
        }
    }

    override func layout() {
        super.layout()
        applyWhenAttached()
    }

    func applyWhenAttached() {
        // Correct attached layout changes before the next frame.
        if splitViewController != nil {
            apply()
            return
        }
        guard !applyScheduled else { return }
        applyScheduled = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            applyScheduled = false
            apply()
        }
    }

    private func apply() {
        guard !isApplying else { return }
        guard let controller = splitViewController else { return }
        isApplying = true
        defer { isApplying = false }
        observeResizes(in: controller.splitView)
        guard let sidebar = controller.splitViewItems.first(where: { $0.behavior == .sidebar }) else { return }

        // The SwiftUI representable's responder chain ends at its hosting view on some
        // macOS releases. Resolve the owning controller through the view-controller tree,
        // and keep enforcing after NavigationSplitView has completed its own layout pass.
        let constraintsChanged = sidebar.minimumThickness != configuration.minimum
            || sidebar.maximumThickness != configuration.maximum
        if constraintsChanged {
            sidebar.minimumThickness = configuration.minimum
            sidebar.maximumThickness = configuration.maximum
            sidebar.canCollapse = false
        }
        let currentWidth = sidebar.viewController.view.frame.width
        if constraintsChanged || abs(currentWidth - configuration.ideal) > 0.5 {
            // The divider already lays out its children on each animation tick.
            // An extra full controller layout here would measure the transcript twice.
            if animationTimer == nil { controller.view.layoutSubtreeIfNeeded() }
            controller.splitView.setPosition(configuration.ideal, ofDividerAt: 0)
            controller.splitView.adjustSubviews()
        }
    }

    private func observeResizes(in splitView: NSSplitView) {
        guard observedSplitView !== splitView else { return }
        if let observedSplitView {
            NotificationCenter.default.removeObserver(self, name: Self.didResizeSubviews, object: observedSplitView)
        }
        observedSplitView = splitView
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(splitViewDidResize(_:)),
            name: Self.didResizeSubviews,
            object: splitView
        )
    }

    // NavigationSplitView can reset its divider after this view's layout pass when the
    // content column changes (for example, Home ↔ project). Reapply after AppKit's resize.
    private static let didResizeSubviews = Notification.Name("NSSplitViewDidResizeSubviewsNotification")

    @objc private func splitViewDidResize(_ notification: Notification) {
        // SwiftUI can restore its native 140pt sidebar minimum during layout. Deferring
        // the correction to another task lets that wider rail render for a frame.
        // Correct it in the same resize pass, including during animation. Our own
        // resize reenters this observer, so `apply` guards against recursion.
        apply()
    }

    private var splitViewController: NSSplitViewController? {
        var view: NSView? = self
        while let current = view {
            var responder: NSResponder? = current
            while let value = responder {
                if let split = value as? NSSplitViewController { return split }
                responder = value.nextResponder
            }
            view = current.superview
        }

        // SwiftUI may not expose the split controller as a parent of the representable.
        // Search the current window's controller tree as a fallback.
        func findSplit(in controller: NSViewController?) -> NSSplitViewController? {
            guard let controller else { return nil }
            if let split = controller as? NSSplitViewController { return split }
            for child in controller.children {
                if let split = findSplit(in: child) { return split }
            }
            return nil
        }
        if let split = findSplit(in: window?.contentViewController) { return split }
        func findSplit(in view: NSView?) -> NSSplitViewController? {
            guard let view else { return nil }
            if let split = view.nextResponder as? NSSplitViewController { return split }
            for child in view.subviews {
                if let split = findSplit(in: child) { return split }
            }
            return nil
        }
        return findSplit(in: window?.contentView)
    }
}

struct SidebarBackground: View {
    var body: some View {
        Theme.sidebar
            .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
            .ignoresSafeArea()
    }
}

/// Shared brand/search chrome for the conversation and Settings sidebars.
struct SidebarBrandHeader: View {
    @Binding var isCollapsed: Bool

    var body: some View {
        HStack(spacing: 8) {
            if !isCollapsed {
                DuckMark(width: 28)
                Text("Squeak").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
            }
            if !isCollapsed { Spacer(minLength: 0) }
            if !isCollapsed {
                Button { NewChatController.shared.showQuickMessage() } label: {
                    Lucide(.squarePen, size: Metrics.sidebarIcon, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Quick message")
                .help("Quick message")
            }
            SidebarCollapseButton(isCollapsed: $isCollapsed)
        }
        .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
        .padding(.horizontal, isCollapsed ? 16 : Metrics.sidebarInset + 4).padding(.top, 36)
    }
}

struct SidebarCollapseButton: View {
    @Binding var isCollapsed: Bool

    var body: some View {
        Button { isCollapsed.toggle() } label: {
            Image(systemName: "sidebar.left")
                .font(.system(size: Metrics.sidebarIcon, weight: .regular))
                .foregroundStyle(Theme.muted)
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCollapsed ? "Expand sidebar" : "Collapse sidebar")
        .help(isCollapsed ? "Expand sidebar (⌘B or ⌘\\)" : "Collapse sidebar (⌘B or ⌘\\)")
    }
}

struct SidebarSearchField: View {
    let prompt: String
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    let accessibilityLabel: String

    var body: some View {
        HStack(spacing: 8) {
            Lucide(.search, size: Metrics.iconSmall, color: Theme.muted)
            TextField(prompt, text: $text)
                .textFieldStyle(.plain).font(.system(size: Metrics.sidebarText)).focused(focused)
                .accessibilityLabel(accessibilityLabel)
            if text.isEmpty {
                Text("⌘ K").font(.system(size: 11)).foregroundStyle(Theme.subtle).accessibilityHidden(true)
            } else {
                Button { text = "" } label: { Lucide(.x, size: 12, color: Theme.muted) }
                    .buttonStyle(.plain).accessibilityLabel("Clear \(accessibilityLabel.lowercased())")
            }
        }
        .padding(.horizontal, 10).frame(height: Metrics.sidebarField)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous).strokeBorder(focused.wrappedValue ? Theme.lineStrong : Theme.line))
    }
}

/// What the sidebar's connection row opens: the state in the daemon's own words, a recheck, and the way to Settings.
struct ConnectionPopover: View {
    let dismiss: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Circle().fill(model.homeConnectionColor).frame(width: 8, height: 8)
                Text(model.homeConnectionText).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
            }
            if let help = model.connectionHelp {
                Text(help).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let synced = model.lastSyncedText {
                Text(synced).font(.system(size: 11)).foregroundStyle(Theme.subtle)
            }
            Divider()
            HStack {
                Button("Check again") { model.recheck() }
                Spacer()
                Button("Open Settings \u{203A} Connections") { dismiss(); model.openSettings(.connections) }
            }
            .font(.system(size: 12))
        }
        .padding(14).frame(width: 300)
    }
}
