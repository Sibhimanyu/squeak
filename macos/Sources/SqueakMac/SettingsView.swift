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
        .frame(width: 480, height: 340)
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
        Form {
            LabeledContent("Squeak service") {
                HStack(spacing: 6) {
                    ConnectionPill()
                }
            }
            LabeledContent("Address") { Text(verbatim: model.client.baseURL.absoluteString).textSelection(.enabled) }
            LabeledContent("Access token") {
                Text(model.tokenPresent ? "Found" : "Missing").foregroundStyle(model.tokenPresent ? Color.primary : Color.red)
            }
            if let synced = model.lastSyncedText { LabeledContent("Sync") { Text(synced) } }
            LabeledContent("Direct Conductor relay") { Text("Not enabled yet").foregroundStyle(.secondary) }
            if let help = model.connectionHelp {
                Text(help).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Button("Check again") { model.recheck() }
        }
        .formStyle(.grouped)
        .padding()
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
    var body: some View {
        VStack(spacing: 8) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64)
            Text("Squeak").font(.title2.bold())
            Text("Version \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "2.0.0 (dev)")")
                .foregroundStyle(.secondary)
            Text("A pager for your coding agents. Reads your sessions and lets you answer them.")
                .multilineTextAlignment(.center).font(.callout).frame(maxWidth: 320)
            Text(Bundle.main.object(forInfoDictionaryKey: "NSHumanReadableCopyright") as? String ?? "")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
