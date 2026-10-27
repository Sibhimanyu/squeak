import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Sidebar

/// The window's left column, drawn by hand to the mockup: a brand line, a search field with a ⌘K hint,
/// 28pt line-icon rows (a count, or a red badge for what needs you), a SOURCES group, and the
/// connection and Settings at the foot. Selection is `model.navFilter`.
struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool

    private var current: NavFilter { model.navFilter ?? .home }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand
            searchField.padding(.horizontal, 10).padding(.top, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    row(.home, "Home", .house)
                    row(.all, "Sessions", .messageSquare)
                    row(.needsYou, "Needs you", .circleAlert)
                    row(.usage, "Usage", .gauge)
                    Text("SOURCES").font(.system(size: Metrics.sectionLabel, weight: .medium)).tracking(0.4).foregroundStyle(Theme.subtle)
                        .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 4)
                        .accessibilityAddTraits(.isHeader)
                    row(.source(.conductor), SessionSource.conductor.title, .gitBranch)
                    row(.source(.terminal), SessionSource.terminal.title, .squareTerminal)
                    row(.source(.claudeDesktop), SessionSource.claudeDesktop.title, .monitor)
                    if model.hasCodexApp { row(.source(.codexApp), SessionSource.codexApp.title, .code) }
                }
                .padding(.horizontal, 10).padding(.top, 10)
            }
            .scrollContentBackground(.hidden)
            footer
        }
        .frame(minWidth: Metrics.sidebarWidth, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bg.ignoresSafeArea())
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
        return Button { model.navFilter = f } label: {
            HStack(spacing: 8) {
                Lucide(symbol, size: Metrics.icon, color: selected ? Theme.ink : Theme.muted).frame(width: 18)
                Text(verbatim: title).font(.system(size: 13, weight: selected ? .medium : .regular)).foregroundStyle(Theme.ink)
                Spacer(minLength: 4)
                if f == .needsYou, n > 0 {
                    Text("\(n)").font(.system(size: 11, weight: .bold)).monospacedDigit().foregroundStyle(.white)
                        .frame(minWidth: 18, minHeight: 18)
                        .background(Theme.needsYou, in: Capsule())
                } else if n > 0 {
                    Text("\(n)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 10).frame(height: Metrics.navRow)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(selected ? Theme.selected : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count(for: f).map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// No duck here: the sidebar is a calm column (DESIGN.md 5). Quick message stays, quiet, at the right.
    private var brand: some View {
        HStack(spacing: 8) {
            Text("Squeak").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Button { QuickComposerController.shared.show() } label: {
                Lucide(.squarePen, size: Metrics.icon, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Quick message").help("Quick message")
        }
        .padding(.horizontal, 20).padding(.top, 10)
    }

    private var searchField: some View {
        @Bindable var model = model
        return HStack(spacing: 8) {
            Lucide(.search, size: Metrics.iconSmall, color: Theme.muted)
            TextField("Search sessions…", text: $model.query)
                .textFieldStyle(.plain).font(.system(size: 13)).focused($searchFocused)
            if model.query.isEmpty {
                Text("\u{2318} K").font(.system(size: 11)).foregroundStyle(Theme.subtle).accessibilityHidden(true)
            } else {
                Button { model.query = "" } label: {
                    Lucide(.x, size: 12, color: Theme.muted)
                }
                .buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 8).frame(height: Metrics.field)
        .background(Theme.surface.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(searchFocused ? Theme.lineStrong : Theme.line))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(model.homeConnectionColor).frame(width: 8, height: 8)
                Text(model.homeConnectionText).font(.system(size: 12)).foregroundStyle(Theme.ink).lineLimit(1)
            }
            .padding(.horizontal, 10).frame(height: 24)
            .accessibilityElement(children: .combine)
            Button { model.openSettings() } label: {
                HStack(spacing: 8) {
                    Lucide(.settings, size: Metrics.icon, color: Theme.muted).frame(width: 18)
                    Text("Settings").font(.system(size: 13)).foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10).frame(height: Metrics.navRow).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}
