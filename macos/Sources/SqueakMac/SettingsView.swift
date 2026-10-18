import AppKit
import SqueakMacCore
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            GeneralSettings().tabItem { Label("General", systemImage: "gearshape") }
            ConnectionsSettings().tabItem { Label("Connections", systemImage: "bolt.horizontal") }
            PrivacySettings().tabItem { Label("Privacy", systemImage: "lock.shield") }
            AboutSettings().tabItem { Label("About", systemImage: "info.circle") }
        }
        .frame(width: 480, height: 400)
    }
}

private struct GeneralSettings: View {
    @Environment(AppModel.self) private var model
    @State private var loginOn = LoginItem.isEnabled
    @State private var loginError: String?

    var body: some View {
        @Bindable var model = model
        Form {
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
            if !Bundled.isApp {
                Text("Available when running the Squeak app (not from a build folder).").font(.caption).foregroundStyle(.secondary)
            }
            if let loginError { Text(loginError).font(.caption).foregroundStyle(.red) }

            Picker("Quick message shortcut", selection: Binding(get: { model.hotKeyID ?? "" }, set: { model.hotKeyID = $0.isEmpty ? nil : $0 })) {
                Text("None").tag("")
                ForEach(HotKeyPreset.all) { Text($0.title).tag($0.id) }
            }
            Text("Works from any app and needs no special permission. It is off until you choose one.")
                .font(.caption).foregroundStyle(.secondary)

            Toggle("Notify me when a session needs me or finishes", isOn: $model.notificationsEnabled)
                .disabled(!Bundled.isApp)
        }
        .formStyle(.grouped)
        .padding()
    }
}

private struct ConnectionsSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let r = model.connectionsReport
        Form {
            row(r.database)
            row(r.daemon)
            row(r.sending)
            LabeledContent("Address") { Text(verbatim: model.client.baseURL.absoluteString).textSelection(.enabled) }
            if let synced = model.lastSyncedText { LabeledContent("Sync") { Text(synced) } }
            if let help = model.connectionHelp {
                Text(help).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Button("Check again") { model.recheck() }
        }
        .formStyle(.grouped)
        .padding()
    }

    private func row(_ r: ConnectionsReport.Row) -> some View {
        LabeledContent(r.title) {
            VStack(alignment: .trailing, spacing: 2) {
                Text(r.value).foregroundStyle(color(r.level))
                if let d = r.detail {
                    Text(d).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func color(_ l: ConnectionsReport.Level) -> Color {
        switch l {
        case .ok: .primary
        case .warning: .orange
        case .problem: .red
        case .neutral: .secondary
        }
    }
}

private struct PrivacySettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirm = false

    var body: some View {
        @Bindable var model = model
        Form {
            Toggle("Show session names in notifications", isOn: $model.notificationsShowNames)
            Text("Off by default. Notifications never contain message text; with this off they don't name the session either.")
                .font(.caption).foregroundStyle(.secondary)
            LabeledContent("Cache") {
                Text("Messages are encrypted on this Mac, kept 14 days, up to 50 MB.").font(.caption).foregroundStyle(.secondary)
            }
            Button("Purge cache…", role: .destructive) { confirm = true }
            if let n = model.cacheNotice { Text(n).font(.caption).foregroundStyle(.secondary) }
        }
        .formStyle(.grouped)
        .padding()
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
        VStack(spacing: 8) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
            Text("Squeak").font(.title2.bold())
            Text("Version \(AppModel.appVersion)").foregroundStyle(.secondary)
            Text("A pager for your coding agents. Reads your sessions and lets you answer them.")
                .multilineTextAlignment(.center).font(.callout).frame(maxWidth: 320)
            Toggle("Check for new versions", isOn: $model.updateChecksEnabled)
                .toggleStyle(.checkbox)
                .help("Asks GitHub once a day whether a newer release exists. Never downloads or installs anything.")
            Button(copied ? "Copied" : "Copy diagnostics") {
                model.copyDiagnostics()
                copied = true
                Task { try? await Task.sleep(for: .seconds(2)); copied = false }
            }
            Text("Versions, source status, session counts and recent log lines. No message text, titles, paths or ids.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 340)
            Text(Bundle.main.object(forInfoDictionaryKey: "NSHumanReadableCopyright") as? String ?? "")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
