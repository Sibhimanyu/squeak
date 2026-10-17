import SqueakMacCore
import SwiftUI

struct PopoverView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            VStack(spacing: 8) {
                ConnectionBanner(compact: true)
                LaunchOfferBanner()
            }
            .padding(.horizontal, 12)
            .padding(.bottom, model.connectionHelp != nil || model.launchOfferPending ? 8 : 0)
            searchBar(query: $model.query)
            Divider().overlay(Theme.line)
            content
            Divider().overlay(Theme.line)
            footer
        }
        .frame(width: 360, height: 520)
        .background(Theme.bg)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.duck).frame(width: 18, height: 18)
                .overlay(Text("S").font(.system(size: 10, weight: .heavy)).foregroundStyle(Color(nsColor: NSColor(hex: 0x3C1804))))
                .accessibilityHidden(true)
            Text("Squeak").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
            ConnectionPill()
            Spacer()
            Button { model.openSettings() } label: { Image(systemName: "gearshape") }
                .buttonStyle(.borderless)
                .foregroundStyle(Theme.muted)
                .accessibilityLabel("Settings")
                .help("Settings")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    private func searchBar(query: Binding<String>) -> some View {
        HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.subtle).font(.system(size: 11))
                TextField("Search sessions and messages", text: query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .accessibilityLabel("Search")
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
            filterMenu
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var filterMenu: some View {
        Menu {
            Button("All sessions") { model.filter = .all }
            if model.providers.count > 1 {
                Divider()
                ForEach(model.providers, id: \.self) { p in Button(providerName(p)) { model.filter = .provider(p) } }
            }
            if !model.repos.isEmpty {
                Divider()
                ForEach(model.repos, id: \.self) { r in Button(r) { model.filter = .repo(r) } }
            }
        } label: {
            Image(systemName: model.filter == .all ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .foregroundStyle(model.filter == .all ? Theme.muted : Theme.duck)
        .accessibilityLabel("Filter by provider or project")
        .help("Filter by provider or project")
    }

    @ViewBuilder
    private var content: some View {
        if model.sessions.isEmpty {
            Spacer(minLength: 0)
            if model.health == nil {
                EmptyStateView(symbol: "ellipsis.circle", title: "Connecting…", message: "Looking for the Squeak service on this Mac.")
            } else if !model.isConnected {
                EmptyStateView(symbol: "bolt.slash", title: "No sessions to show", message: "Squeak can't reach its service yet, so there is nothing to list. The fix is above.")
            } else {
                EmptyStateView(symbol: "tray", title: "No sessions yet", message: "Start a chat in Conductor and it shows up here, with its replies.")
            }
            Spacer(minLength: 0)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    SessionSections { model.open($0) }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Button {
                QuickComposerController.shared.show()
            } label: {
                Label("Quick message", systemImage: "square.and.pencil")
            }
            .buttonStyle(PrimaryButtonStyle())
            Button("Open Squeak") { model.showConversationWindow() }
                .buttonStyle(QuietButtonStyle())
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }
                .buttonStyle(QuietButtonStyle())
                .keyboardShortcut("q")
                .help("Quit Squeak")
        }
        .padding(12)
    }
}

func providerName(_ p: String) -> String {
    switch p {
    case "conductor": "Conductor"
    case "claude-terminal": "Claude (Terminal)"
    case "codex-terminal": "Codex (Terminal)"
    default: p.capitalized
    }
}
