import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Sidebar

/// The window's left column, drawn by hand to the mockup: a brand line, a search field with a ⌘K hint,
/// 36pt line-icon rows (a count, or a red badge for what needs you), a SOURCES group, and the
/// connection and Settings at the foot. Selection is `model.navFilter`.
/// Behind-window vibrancy for the sidebar column, tinted warm so it blends with the dark theme.
private struct SidebarGlass: NSViewRepresentable {
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = .sidebar
        v.blendingMode = .behindWindow
        v.state = .followsWindowActiveState
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {}
}

/// NavigationSplitView assigns its AppKit sidebar item a 140pt minimum even when the
/// SwiftUI column-width preference is lower. Update that native constraint alongside
/// the sidebar content so the entire column, including its material, becomes an icon rail.
struct SidebarColumnSizer: NSViewRepresentable {
    let isCollapsed: Bool
    let expandedMinimum: CGFloat
    let expandedIdeal: CGFloat
    let expandedMaximum: CGFloat

    func makeNSView(context: Context) -> SidebarColumnSizerView {
        SidebarColumnSizerView(configuration: configuration)
    }

    func updateNSView(_ view: SidebarColumnSizerView, context: Context) {
        view.configuration = configuration
        view.applyWhenAttached()
    }

    private var configuration: SidebarColumnSizerView.Configuration {
        .init(
            isCollapsed: isCollapsed,
            expandedMinimum: expandedMinimum,
            expandedIdeal: expandedIdeal,
            expandedMaximum: expandedMaximum
        )
    }
}

@MainActor
final class SidebarColumnSizerView: NSView {
    struct Configuration: Equatable {
        let isCollapsed: Bool
        let expandedMinimum: CGFloat
        let expandedIdeal: CGFloat
        let expandedMaximum: CGFloat

        var minimum: CGFloat { isCollapsed ? 64 : expandedMinimum }
        var ideal: CGFloat { isCollapsed ? 64 : expandedIdeal }
        var maximum: CGFloat { isCollapsed ? 64 : expandedMaximum }
    }

    var configuration: Configuration
    private var applyScheduled = false
    private var isApplying = false
    private weak var observedSplitView: NSSplitView?

    init(configuration: Configuration) {
        self.configuration = configuration
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        applyWhenAttached()
    }

    override func layout() {
        super.layout()
        applyWhenAttached()
    }

    func applyWhenAttached() {
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
            controller.view.layoutSubtreeIfNeeded()
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
        // Correct a collapsed rail in the same resize pass; our own resize reenters
        // this observer, so `apply` guards against recursive corrections.
        if configuration.isCollapsed { apply() }
        else { applyWhenAttached() }
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
    @Environment(\.accessibilityReduceTransparency) private var reduce
    @Environment(\.glassWindowEnabled) private var glassEnabled
    @Environment(\.glassTransparency) private var transparency
    @Environment(\.glassSidebarContrast) private var sidebarContrast

    var body: some View {
        Group {
            if reduce || !glassEnabled {
                Theme.sidebar
            } else {
                ZStack {
                    SidebarGlass()
                    Theme.sidebar.opacity(sidebarWashOpacity)
                }
            }
        }
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
        .ignoresSafeArea()
    }

    /// Matches the main material tint, with a separate user controlled amount for the sidebar.
    private var sidebarWashOpacity: Double {
        let mainWash = (1 - min(max(transparency, 0), 100) / 100) * 0.42
        let addedContrast = min(max(sidebarContrast, 0), 100) / 100 * 0.42
        return min(mainWash + addedContrast, 0.72)
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

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Binding var isCollapsed: Bool
    @FocusState private var searchFocused: Bool
    @State private var showConnection = false

    private var current: NavFilter { model.navFilter ?? .home }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand
            if !isCollapsed { searchField.padding(.horizontal, Metrics.sidebarInset).padding(.top, 14) }
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.sidebarRowGap) {
                    Button { NewChatController.shared.show() } label: {
                        HStack(spacing: 12) {
                            Lucide(.plus, size: Metrics.sidebarIcon, color: Theme.muted).frame(width: 20)
                            if !isCollapsed {
                                Text("New chat").font(.system(size: Metrics.sidebarText)).foregroundStyle(Theme.ink)
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
                        .padding(.horizontal, isCollapsed ? 0 : 12).frame(height: Metrics.navRow)
                        .background(RoundedRectangle(cornerRadius: Metrics.sidebarRadius).fill(NewChatController.shared.page == .newChat ? Color.white.opacity(0.10) : .clear))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(NewChatController.shared.page == .newChat ? .isSelected : [])
                    .accessibilityLabel("New chat")
                    .help("New chat (⌘N)")
                    row(.home, "Home", .house)
                    row(.all, "Sessions", .messageSquare)
                    row(.needsYou, "Needs you", .circleAlert)
                    row(.usage, "Usage", .gauge)
                    if !isCollapsed {
                        Text("SOURCES").font(.system(size: Metrics.sectionLabel, weight: .medium)).tracking(0.4).foregroundStyle(Theme.subtle)
                            .padding(.horizontal, 12).padding(.top, 16).padding(.bottom, 0)
                            .accessibilityAddTraits(.isHeader)
                    }
                    row(.source(.conductor), SessionSource.conductor.title, .gitBranch)
                    row(.source(.terminal), SessionSource.terminal.title, .squareTerminal)
                    row(.source(.claudeDesktop), SessionSource.claudeDesktop.title, .monitor)
                    if model.hasCodexApp { row(.source(.codexApp), SessionSource.codexApp.title, .code) }
                }
                .padding(.horizontal, isCollapsed ? 8 : Metrics.sidebarInset).padding(.top, 14)
            }
            .scrollContentBackground(.hidden)
            footer
        }
        // Give the split view an actual narrow fitting view when collapsed. A minimum width
        // alone still lets NavigationSplitView keep the last expanded sidebar width.
        .frame(width: isCollapsed ? 64 : Metrics.sidebarWidth, alignment: .topLeading)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
        .background {
            SidebarColumnSizer(
                isCollapsed: isCollapsed,
                expandedMinimum: Metrics.sidebarWidth,
                expandedIdeal: Metrics.sidebarWidth,
                expandedMaximum: Metrics.sidebarWidth
            )
            .frame(width: 0, height: 0)
        }
        .background {
            // ⌘K focuses the search field, wherever focus is.
            Button("Search") { searchFocused = true }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0).accessibilityHidden(true)
        }
    }

    private func count(for f: NavFilter) -> Int? {
        switch f {
        case .home, .usage, .source: nil
        default: model.count(f)
        }
    }

    private func row(_ f: NavFilter, _ title: String, _ symbol: LucideName) -> some View {
        let selected = NewChatController.shared.page == nil && current == f
        let n = count(for: f) ?? 0
        return Button { NewChatController.shared.hide(); model.navFilter = f; model.projectFilter = nil } label: {
            HStack(spacing: 12) {
                Lucide(symbol, size: Metrics.sidebarIcon, color: selected ? Theme.working : Theme.muted).frame(width: 20)
                if !isCollapsed {
                    Text(verbatim: title).font(.system(size: Metrics.sidebarText, weight: selected ? .medium : .regular)).foregroundStyle(Theme.ink)
                    Spacer(minLength: 4)
                }
                if !isCollapsed, f == .needsYou, n > 0 {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.needsYou).frame(width: 7, height: 7)
                        Text("\(n)").font(.system(size: 13)).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                } else if !isCollapsed, n > 0 {
                    Text("\(n)").font(.system(size: 13)).monospacedDigit().foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
            .padding(.horizontal, isCollapsed ? 0 : 12).frame(height: Metrics.navRow)
            .background(RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous).fill(selected ? Color.white.opacity(0.10) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count(for: f).map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(title)
    }

    /// Duck and wordmark at the left, Quick message (compose) at the right, centred below the traffic lights.
    private var brand: some View {
        SidebarBrandHeader(isCollapsed: $isCollapsed)
    }

    private var searchField: some View {
        @Bindable var model = model
        return SidebarSearchField(prompt: "Search sessions…", text: $model.query, focused: $searchFocused, accessibilityLabel: "Search sessions")
    }

    private var footer: some View {
        VStack(alignment: isCollapsed ? .center : .leading, spacing: Metrics.sidebarRowGap) {
            Button { showConnection.toggle() } label: {
                HStack(spacing: 12) {
                    Circle().strokeBorder(model.homeConnectionColor, lineWidth: 2.5).frame(width: 16, height: 16).frame(width: 20)
                    if !isCollapsed {
                        Text(model.homeConnectionText).font(.system(size: Metrics.sidebarText)).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 0)
                        Lucide(.chevronRight, size: Metrics.iconSmall, color: Theme.muted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
                .padding(.horizontal, isCollapsed ? 0 : 12).frame(height: Metrics.navRow).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connection: \(model.homeConnectionText)")
            .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
            Button { model.openSettings() } label: {
                HStack(spacing: 12) {
                    Lucide(.settings, size: Metrics.sidebarIcon, color: Theme.muted).frame(width: 20)
                    if !isCollapsed { Text("Settings").font(.system(size: Metrics.sidebarText)).foregroundStyle(Theme.ink); Spacer(minLength: 0) }
                }
                .frame(maxWidth: .infinity, alignment: isCollapsed ? .center : .leading)
                .padding(.horizontal, isCollapsed ? 0 : 12).frame(height: Metrics.navRow).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, isCollapsed ? 8 : Metrics.sidebarInset).padding(.vertical, 12)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, Metrics.sidebarInset) }
    }
}

/// What the sidebar's connection row opens: the state in the daemon's own words, a recheck, and the way to Settings.
private struct ConnectionPopover: View {
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
