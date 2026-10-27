import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.navFilter) {
            Section {
                row(.home, "Home", .house)
                row(.all, "Sessions", .list)
                row(.needsYou, "Needs you", .bell)
            }
            Section {
                LucideLabel("Usage", .gauge).tag(NavFilter.usage)
                    .accessibilityLabel("Usage")
            }
            Section("Sources") {
                source(.conductor, .gitBranch)
                source(.terminal, .terminal)
                source(.claudeDesktop, .monitor)
                if model.hasCodexApp { source(.codexApp, .code) }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { brand }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }

    private func row(_ f: NavFilter, _ title: String, _ symbol: LucideName) -> some View {
        HStack {
            LucideLabel(title, symbol)
            Spacer(minLength: 4)
            count(model.count(f), needsYou: f == .needsYou)
        }
        .tag(f)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(model.count(f))")
    }

    /// 8.3: a red pill with a white count for things that need you; every other count is plain muted text.
    @ViewBuilder private func count(_ n: Int, needsYou: Bool) -> some View {
        if needsYou && n > 0 {
            Text("\(n)").font(.system(size: 11, weight: .bold)).monospacedDigit().foregroundStyle(.white)
                .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
                .background(Theme.needsYou, in: Capsule())
        } else if n > 0 {
            Text("\(n)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
        }
    }

    private func source(_ s: SessionSource, _ symbol: LucideName) -> some View {
        LucideLabel(s.title, symbol).tag(NavFilter.source(s))
    }

    /// No duck here: the sidebar sits on the system's glass, and glass never sits behind the duck (DESIGN.md 5).
    private var brand: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button { QuickComposerController.shared.show() } label: {
                Lucide(.squarePen, size: 20, color: Theme.muted).frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
            .accessibilityLabel("Quick message").help("Quick message")
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Circle().fill(model.homeConnectionColor).frame(width: 9, height: 9)
                Text(model.homeConnectionText).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Button { model.openSettings() } label: {
                LucideLabel("Settings", .settings).font(Typo.body)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 12)
    }
}
