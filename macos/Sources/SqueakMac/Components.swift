import SqueakMacCore
import SwiftUI

struct SessionRow: View {
    let session: HostSession
    var pinned = false
    var snippet: String?

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if pinned {
                        Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(Theme.subtle)
                            .accessibilityLabel("Pinned")
                    }
                    Text(verbatim: session.label)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                }
                Text(verbatim: snippet ?? subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            VStack(alignment: .trailing, spacing: 3) {
                HStack(spacing: 5) {
                    StateDot(state: session.state)
                    Text(Theme.label(for: session.state))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(Theme.color(for: session.state))
                }
                if let t = session.lastActivityAt {
                    Text(t.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))
                        .font(.system(size: 10))
                        .foregroundStyle(Theme.subtle)
                        .monospacedDigit()
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        [session.repoName, session.branch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

struct ConnectionPill: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(model.hasLoaded || model.health != nil ? model.connectionTitle : "Connecting…")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.ink)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Theme.surfaceRaised.opacity(0.8), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Connection: \(model.connectionTitle)")
    }

    private var color: Color {
        switch model.effectiveStatus {
        case .connected: Theme.working
        case .daemonDown: Theme.needsYou
        case .tokenMissing, .degraded: Theme.duck
        }
    }
}

/// Plain-language state of the link to Squeak, with the fix.
struct ConnectionBanner: View {
    @Environment(AppModel.self) private var model
    var compact = false

    var body: some View {
        if let help = model.connectionHelp, model.health != nil {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.duck)
                    Text(model.connectionTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
                    Spacer()
                    Button("Check again") { model.recheck() }.buttonStyle(QuietButtonStyle())
                }
                Text(help)
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(compact ? 3 : nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                if let synced = model.lastSyncedText {
                    Text(synced).font(.system(size: 10)).foregroundStyle(Theme.subtle)
                }
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.duck.opacity(0.4)))
        }
    }
}

struct LaunchOfferBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.launchOfferPending {
            HStack(spacing: 8) {
                Text("Open Squeak when you log in?")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Button("Not now") { model.answerLaunchOffer(enable: false) }.buttonStyle(QuietButtonStyle())
                Button("Turn on") { model.answerLaunchOffer(enable: true) }.buttonStyle(PrimaryButtonStyle())
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

struct EmptyStateView: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 28)).foregroundStyle(Theme.subtle)
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(message).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: 320)
        .accessibilityElement(children: .combine)
    }
}

/// Session list shared by the popover and the window sidebar.
struct SessionSections: View {
    @Environment(AppModel.self) private var model
    var onOpen: (SessionKey) -> Void

    var body: some View {
        if model.isSearching {
            let hits = model.searchHits
            if hits.isEmpty {
                EmptyStateView(symbol: "magnifyingglass", title: "No matches", message: "Search looks at session titles and messages Squeak has already opened on this Mac.")
            } else {
                ForEach(hits, id: \.key) { hit in
                    if let s = model.session(hit.key) {
                        row(s, snippet: hit.titleMatch ? nil : hit.snippet)
                    }
                }
            }
        } else {
            let o = model.ordered
            section("Pinned", o.pinned, pinned: true)
            section("Active", o.active)
            section("Recent", o.recent)
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ list: [HostSession], pinned: Bool = false) -> some View {
        if !list.isEmpty {
            Section {
                ForEach(list) { row($0, pinned: pinned) }
            } header: {
                Text(title.uppercased()).font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.subtle)
            }
        }
    }

    private func row(_ s: HostSession, pinned: Bool = false, snippet: String? = nil) -> some View {
        SessionRow(session: s, pinned: pinned || model.pinned.contains(s.key), snippet: snippet)
            .tag(s.key)
            .onTapGesture { onOpen(s.key) }
            .accessibilityAddTraits(.isButton)
            .contextMenu {
                Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
            }
    }
}

/// A quiet notice that a newer release exists. Opens the release page; nothing is downloaded.
struct UpdateBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let u = model.availableUpdate {
            HStack(spacing: 8) {
                Image(systemName: "arrow.down.circle").foregroundStyle(Theme.muted).accessibilityHidden(true)
                Text("Squeak \(u.version.description) is available")
                    .font(.system(size: 12)).foregroundStyle(Theme.ink)
                Spacer()
                Button("View release") { model.viewRelease() }.buttonStyle(QuietButtonStyle())
                Button { model.dismissUpdate() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).foregroundStyle(Theme.subtle)
                    .accessibilityLabel("Dismiss")
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
