import AppKit
import SqueakMacCore
import SwiftUI

struct SettingsView: View {
    enum Tab: Hashable { case general, connections, privacy, about }
    /// SQUEAK_MAC_SETTINGS_TAB lets a capture land on a tab; otherwise General.
    @State private var tab: Tab = {
        switch ProcessInfo.processInfo.environment["SQUEAK_MAC_SETTINGS_TAB"] {
        case "connections": .connections
        case "privacy": .privacy
        case "about": .about
        default: .general
        }
    }()

    var body: some View {
        TabView(selection: $tab) {
            GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }.tag(Tab.general)
            ConnectionsSettings().tabItem { Label("Connections", systemImage: "link") }.tag(Tab.connections)
            PrivacySettings().tabItem { Label("Privacy", systemImage: "hand.raised") }.tag(Tab.privacy)
            AboutSettings().tabItem { Label("About", systemImage: "info.circle") }.tag(Tab.about)
        }
        .frame(width: 520, height: 440)
    }
}

/// Native-style section footer: leading-aligned, secondary, wraps.
private struct SectionFootnote: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.callout).foregroundStyle(.secondary)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct GeneralSettings: View {
    @Environment(AppModel.self) private var model
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String?

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Toggle("Open Squeak when I log in", isOn: Binding(
                    get: { loginOn },
                    set: { on in
                        do {
                            try LoginItem.set(on)
                            loginOn = LoginItem.isEnabled
                            loginError = nil
                        } catch {
                            loginOn = LoginItem.isEnabled
                            loginError = error.localizedDescription
                        }
                    }
                ))
                .disabled(!Bundled.isApp)
            } footer: {
                if let loginError {
                    SectionFootnote(loginError)
                } else if !Bundled.isApp {
                    SectionFootnote("Available when running the Squeak app, not from a build folder.")
                }
            }
            Section {
                Picker("Quick message shortcut", selection: Binding(get: { model.hotKeyID ?? "" }, set: { model.hotKeyID = $0.isEmpty ? nil : $0 })) {
                    Text("None").tag("")
                    ForEach(HotKeyPreset.all) { Text($0.title).tag($0.id) }
                }
            } footer: {
                SectionFootnote("Works from any app and needs no special permission. It is off until you choose one.")
            }
            Section {
                Toggle("Notify me when a session needs me or finishes", isOn: $model.notificationsEnabled)
                    .disabled(!Bundled.isApp)
            }
        }
        .formStyle(.grouped)
    }
}

private struct ConnectionsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let r = model.connectionsReport
        Form {
            Section {
                row(r.database, name: "Conductor", okWord: "reading chats", okColor: Theme.working)
                row(r.daemon, name: "Squeak service", okWord: "connected", okColor: Theme.working)
                row(r.sending, name: "Sending", okWord: "available", okColor: Theme.done)
            } footer: {
                SectionFootnote("Squeak reads agent chats locally and sends replies only when you choose.")
            }
            Section {
                LabeledContent("Address") { Text(verbatim: model.client.baseURL.absoluteString).textSelection(.enabled) }
                if let synced = model.lastSyncedText { LabeledContent("Sync") { Text(synced) } }
                Button("Check again") { model.recheck() }
            } footer: {
                if let help = model.connectionHelp { SectionFootnote(help) }
            }
        }
        .formStyle(.grouped)
    }

    private func row(_ r: ConnectionsReport.Row, name: String, okWord: String, okColor: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Circle().fill(color(r.level, ok: okColor)).frame(width: 9, height: 9)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                (Text(name).font(.system(size: 13, weight: .medium))
                    + Text("  —  ").foregroundStyle(.secondary)
                    + Text(r.level == .ok ? okWord : r.value.lowercased()).foregroundStyle(.secondary))
                if let d = r.detail, r.level != .ok {
                    Text(d).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name), \(r.level == .ok ? okWord : r.value)")
    }

    private func color(_ l: ConnectionsReport.Level, ok: Color) -> Color {
        switch l {
        case .ok: ok
        case .warning: Theme.error
        case .problem: Theme.needsYou
        case .neutral: Theme.subtle
        }
    }
}

private struct PrivacySettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirm = false

    var body: some View {
        @Bindable var model = model
        Form {
            Section {
                Toggle("Show session names in notifications", isOn: $model.notificationsShowNames)
            } footer: {
                SectionFootnote("Off by default. Notifications never contain message text; with this off they don't name the session either.")
            }
            Section {
                Button("Purge cache…", role: .destructive) { confirm = true }
            } header: {
                Text("Message cache")
            } footer: {
                SectionFootnote(model.cacheNotice ?? "Messages are encrypted on this Mac, kept 14 days, up to 50 MB.")
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Delete the message cache and its encryption key?", isPresented: $confirm) {
            Button("Delete cache", role: .destructive) { Task { await model.purgeCache() } }
        } message: {
            Text("Drafts stored with it are deleted too. Nothing in Conductor changes.")
        }
    }
}

private struct AboutSettings: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            VStack(spacing: 6) {
                DuckGlyph(size: 56)
                Text("Squeak").font(.title2.bold())
                Text("Version \(AppModel.appVersion)").foregroundStyle(.secondary)
                Text("A pager for your coding agents. Reads your sessions and lets you answer them.")
                    .multilineTextAlignment(.center).font(.callout).foregroundStyle(.secondary).frame(maxWidth: 320)
            }
            .padding(.top, 24)
            Form {
                Section {
                    Toggle("Automatically check for updates", isOn: Binding(get: { model.updater.automaticallyChecks }, set: { model.updater.automaticallyChecks = $0 }))
                        .disabled(!model.updater.isActive)
                    Button("Check for Updates…") { model.updater.checkForUpdates() }
                        .disabled(!model.updater.canCheck)
                } footer: {
                    SectionFootnote("Squeak checks once a day, and installs a new version for you when you quit or relaunch it. Nothing about your chats is sent.")
                }
                Section {
                    Button(copied ? "Copied" : "Copy diagnostics") {
                        model.copyDiagnostics()
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                    }
                } footer: {
                    SectionFootnote("Versions, source status, session counts and recent log lines. No message text, titles, paths or ids.")
                }
            }
            .formStyle(.grouped)
        }
    }
}
