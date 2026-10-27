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

private struct SidebarBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduce
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Group {
            if reduce {
                Theme.sidebar
            } else {
                ZStack {
                    SidebarGlass()
                    // Conductor's #24211E at ~60% in dark; a light veil in light mode.
                    (scheme == .dark ? Color(red: 36 / 255, green: 33 / 255, blue: 30 / 255).opacity(0.6) : Color.white.opacity(0.35))
                }
            }
        }
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1) }
        .ignoresSafeArea()
    }
}

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @State private var showConnection = false

    private var current: NavFilter { model.navFilter ?? .home }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand
            searchField.padding(.horizontal, Metrics.sidebarInset).padding(.top, 14)
            ScrollView {
                VStack(alignment: .leading, spacing: Metrics.sidebarRowGap) {
                    row(.home, "Home", .house)
                    row(.all, "Sessions", .messageSquare)
                    row(.needsYou, "Needs you", .circleAlert)
                    row(.usage, "Usage", .gauge)
                    Text("SOURCES").font(.system(size: Metrics.sectionLabel, weight: .medium)).tracking(0.4).foregroundStyle(Theme.subtle)
                        .padding(.horizontal, 12).padding(.top, 16).padding(.bottom, 0)
                        .accessibilityAddTraits(.isHeader)
                    row(.source(.conductor), SessionSource.conductor.title, .gitBranch)
                    row(.source(.terminal), SessionSource.terminal.title, .squareTerminal)
                    row(.source(.claudeDesktop), SessionSource.claudeDesktop.title, .monitor)
                    if model.hasCodexApp { row(.source(.codexApp), SessionSource.codexApp.title, .code) }
                }
                .padding(.horizontal, Metrics.sidebarInset).padding(.top, 14)
            }
            .scrollContentBackground(.hidden)
            footer
        }
        .frame(minWidth: Metrics.sidebarWidth, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
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
        let selected = current == f
        let n = count(for: f) ?? 0
        return Button { model.navFilter = f; model.projectFilter = nil } label: {
            HStack(spacing: 12) {
                Lucide(symbol, size: Metrics.sidebarIcon, color: selected ? Theme.working : Theme.muted).frame(width: 20)
                Text(verbatim: title).font(.system(size: Metrics.sidebarText, weight: selected ? .medium : .regular)).foregroundStyle(Theme.ink)
                Spacer(minLength: 4)
                if f == .needsYou, n > 0 {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.needsYou).frame(width: 7, height: 7)
                        Text("\(n)").font(.system(size: 13)).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                } else if n > 0 {
                    Text("\(n)").font(.system(size: 13)).monospacedDigit().foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 12).frame(height: Metrics.navRow)
            .background(RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous).fill(selected ? Color.white.opacity(0.10) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count(for: f).map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// Duck and wordmark at the left, Quick message (compose) at the right, centred below the traffic lights.
    private var brand: some View {
        HStack(spacing: 8) {
            DuckMark(width: 28)
            Text("Squeak").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button { QuickComposerController.shared.show() } label: {
                Lucide(.squarePen, size: Metrics.sidebarIcon, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Quick message").help("Quick message")
        }
        .padding(.horizontal, Metrics.sidebarInset + 4).padding(.top, 36)
    }

    private var searchField: some View {
        @Bindable var model = model
        return HStack(spacing: 8) {
            Lucide(.search, size: Metrics.iconSmall, color: Theme.muted)
            TextField("Search sessions…", text: $model.query)
                .textFieldStyle(.plain).font(.system(size: Metrics.sidebarText)).focused($searchFocused)
            if model.query.isEmpty {
                Text("\u{2318} K").font(.system(size: 11)).foregroundStyle(Theme.subtle).accessibilityHidden(true)
            } else {
                Button { model.query = "" } label: {
                    Lucide(.x, size: 12, color: Theme.muted)
                }
                .buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10).frame(height: Metrics.sidebarField)
        .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Metrics.sidebarRadius, style: .continuous).strokeBorder(searchFocused ? Theme.lineStrong : Theme.line))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Metrics.sidebarRowGap) {
            Button { showConnection.toggle() } label: {
                HStack(spacing: 12) {
                    Circle().strokeBorder(model.homeConnectionColor, lineWidth: 2.5).frame(width: 16, height: 16).frame(width: 20)
                    Text(model.homeConnectionText).font(.system(size: Metrics.sidebarText)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 0)
                    Lucide(.chevronRight, size: Metrics.iconSmall, color: Theme.muted)
                }
                .padding(.horizontal, 12).frame(height: Metrics.navRow).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connection: \(model.homeConnectionText)")
            .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
            Button { model.openSettings() } label: {
                HStack(spacing: 12) {
                    Lucide(.settings, size: Metrics.sidebarIcon, color: Theme.muted).frame(width: 20)
                    Text("Settings").font(.system(size: Metrics.sidebarText)).foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12).frame(height: Metrics.navRow).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, Metrics.sidebarInset).padding(.vertical, 12)
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
