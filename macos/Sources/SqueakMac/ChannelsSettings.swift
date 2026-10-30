import AppKit
import CoreImage.CIFilterBuiltins
import SqueakIcons
import SqueakMacCore
import SwiftUI
import UniformTypeIdentifiers

/// Destructive (§8.9): surface-raised fill, needs-you-red text.
struct DestructiveButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.label)
            .foregroundStyle(Theme.needsYou)
            .padding(.horizontal, 12)
            .frame(minHeight: 28)
            .background(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

struct Footnote: View {
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

struct StatusLine: View {
    let dot: Color?
    let text: String
    var detail: String? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if let dot { Circle().fill(dot).frame(width: 9, height: 9).accessibilityHidden(true) }
            VStack(alignment: .leading, spacing: 2) {
                Text(text).font(.system(size: 13, weight: .medium))
                if let detail { Text(detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Telegram

struct TelegramSettings: View {
    @Environment(AppModel.self) private var app
    @State private var linking = false
    @State private var confirmOff = false
    @State private var copied = false

    private var m: ChannelsModel { app.channels }

    var body: some View {
        @Bindable var m = app.channels
        Group {
            VStack(alignment: .leading, spacing: 22) {
                telegramStatus
                telegramToken(m: $m)
                allowedChats
                botPicture
                telegramActions
            }
            .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        }
        .task { await m.refresh() }
        .sheet(isPresented: $linking) { LinkChatSheet().environment(app) }
        .confirmationDialog("Turn off Telegram?", isPresented: $confirmOff) {
            Button("Turn off and remove token", role: .destructive) { Task { await m.turnOffTelegram() } }
        } message: {
            Text("Squeak stops sending cards to Telegram. Your linked chats are kept.")
        }
    }

    // MARK: Telegram

    private var telegramStatus: some View {
        SettingsCard(title: "Status", subtitle: "See whether your bot is ready to send updates.", symbol: "paperplane.fill") {
            if !m.daemonReachable {
                StatusLine(dot: Theme.needsYou, text: "Squeak service is off", detail: "Changes are saved, and take effect when the service starts.")
            } else if m.channelsOutdated {
                StatusLine(dot: nil, text: "Update the Squeak service", detail: "This service is older than the app and can't report channel status. Saving still works.")
            } else if let t = m.channels?.telegram {
                switch (t.configured, t.polling) {
                case (false, _): StatusLine(dot: nil, text: "Telegram is not set up")
                case (true, .ok): StatusLine(dot: Theme.working, text: t.botUsername.map { "Connected as @\($0)" } ?? "Connected")
                case (true, .error): StatusLine(dot: Theme.error, text: "Telegram is not connecting", detail: t.lastError)
                case (true, .off): StatusLine(dot: nil, text: "Telegram is off")
                }
            } else {
                StatusLine(dot: nil, text: "Checking")
            }
            if m.restarting {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Restarting the Squeak service…").foregroundStyle(.secondary) }
            }
            if let n = m.notice { Footnote(n) }
        }
    }

    private func telegramToken(m: Bindable<ChannelsModel>) -> some View {
        SettingsCard(title: "Bot token", subtitle: "Connect the Telegram bot you want Squeak to use.", symbol: "key.fill") {
            if self.m.tokenSet && !self.m.changingToken {
                HStack(spacing: 8) {
                    Text("Bot token")
                    Spacer(minLength: 8)
                    Text("Set").foregroundStyle(.secondary)
                    Button("Change") { self.m.changingToken = true }.buttonStyle(SecondaryButtonStyle())
                }
            } else {
                HStack(spacing: 8) {
                    LabeledContent("Bot token") {
                        SecureField("Bot token", text: m.tokenDraft, prompt: Text("123456789:ABC…"))
                            .textFieldStyle(.roundedBorder)
                    }
                    Button("Paste") { self.m.pasteToken() }.buttonStyle(SecondaryButtonStyle())
                }
                if !self.m.tokenDraft.trimmed.isEmpty && !self.m.tokenLooksValid {
                    Text("That doesn't look like a bot token. It is a number, a colon, then letters and digits.")
                        .font(.caption).foregroundStyle(Theme.muted)
                }
                if self.m.tokenSet {
                    Button("Cancel") { self.m.tokenDraft = ""; self.m.changingToken = false }.buttonStyle(QuietButtonStyle())
                }
            }

            Footnote("Create a bot with @BotFather, then paste its token here. The token stays on this Mac, in Squeak's settings file, and is never shown again.")
        }
    }

    private var allowedChats: some View {
        SettingsCard(title: "Allowed chats", subtitle: "Choose who can talk to your bot.", symbol: "person.2.fill") {
            if m.allowed.isEmpty {
                Text("No chats linked").foregroundStyle(.secondary)
            }
            ForEach(m.allowed, id: \.self) { id in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(m.name(for: id) ?? "Chat").font(.system(size: 13, weight: .medium))
                        Text(verbatim: "ID \(id)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                    }
                    Spacer()
                    Button { m.unlink(id) } label: { Lucide(.x, size: 14, color: Theme.muted) }
                        .buttonStyle(.plain)
                        .help("Remove this chat")
                        .accessibilityLabel("Remove chat \(m.name(for: id) ?? String(id))")
                }
            }
            Button("Link a chat…") { linking = true }.buttonStyle(SecondaryButtonStyle())
                .disabled(!(m.tokenSet || !m.tokenDraft.trimmed.isEmpty) && !m.demo)

            if m.channels?.telegram.open == true && m.allowed.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Lucide(.triangleAlert, size: 13, color: Theme.muted)
                    Footnote("No chat is linked, so anyone who finds the bot could message it. Link your own chat to limit it.")
                }
            } else {
                Footnote("Only these chats can talk to the bot. Link one by sending the bot a message.")
            }
        }
    }

    private var botPicture: some View {
        SettingsCard(title: "Bot picture", subtitle: "Give your Telegram bot a familiar face.", symbol: "photo") {
            HStack(spacing: 12) {
                BotLogoPreview()
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bot picture")
                    Text("The duck on Ink, as the bot's profile photo.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                if m.avatarState.isWorking { ProgressView().controlSize(.small) }
                Button("Use Squeak logo") { Task { await m.setTelegramAvatar() } }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(!m.avatarState.canSet(telegramConfigured: m.tokenSet))
            }

            if let line = BotAvatarText.line(m.avatarState) {
                Text(line).font(.callout).foregroundStyle(m.avatarState.isError ? Theme.needsYou : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            } else if !m.tokenSet {
                Footnote("Set the bot token first.")
            }
        }
    }

    private var telegramActions: some View {
        SettingsCard(title: "Save & test", subtitle: "Apply your changes, then check the connection.", symbol: "checkmark.circle") {
            HStack(spacing: 8) {
                Button("Save") { Task { await m.saveTelegram() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!m.telegramDirty || m.restarting || (!m.tokenDraft.trimmed.isEmpty && !m.tokenLooksValid))
                Button(m.testing ? "Sending…" : "Send test message") { Task { await m.sendTest() } }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(m.testing || m.telegramDirty || m.allowed.isEmpty || !m.tokenSet)
                Spacer()
                if m.tokenSet {
                    Button("Turn off…") { confirmOff = true }.buttonStyle(DestructiveButtonStyle()).disabled(m.restarting)
                }
            }

            if let r = m.testResult { Footnote(r) } else if m.telegramDirty { Footnote("Saving restarts the Squeak service for a few seconds.") }
        }
    }
}

/// The bot's profile picture from the brand kit, as a chat app crops it: a circle.
struct BotLogoPreview: View {
    var body: some View {
        Group {
            if let img = BrandAssets.image(ChannelsModel.botLogoFile) {
                Image(nsImage: img).resizable().interpolation(.high).scaledToFill()
            } else {
                Theme.surfaceRaised
            }
        }
        .frame(width: 36, height: 36)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(Theme.line))
        .accessibilityLabel("Squeak bot logo")
    }
}

// MARK: - Zoho Cliq

struct CliqSettings: View {
    @Environment(AppModel.self) private var app
    @State private var copied = false
    private var m: ChannelsModel { app.channels }

    var body: some View {
        @Bindable var m = app.channels
        VStack(alignment: .leading, spacing: 22) {
            cliqAbout
            cliqConnection(m: $m)
            cliqOwner(m: $m)
            botLogo
            twoWaySection
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await m.refresh() }
    }

    /// What the bot is and what it needs, so nobody has to leave the app for a repository page.
    private var cliqAbout: some View {
        SettingsCard(title: "How it works", subtitle: "Updates out, replies back to your agents.", symbol: "info.circle.fill") {
            Text("Squeak talks to Zoho Cliq through a bot you create in Cliq. It posts a card when an agent needs you or finishes, and your taps and replies come back to the agent.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Text("Cards go out through the bot's webhook URL. Replies come back through the Replies setup below.")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func cliqConnection(m: Bindable<ChannelsModel>) -> some View {
        SettingsCard(title: "Webhook", subtitle: "Send agent updates through your Cliq bot.", symbol: "link") {
            if let c = self.m.channels?.cliq {
                StatusLine(dot: nil, text: c.twoWay ? "Two-way: cards go out and replies come back" : c.oneWay ? "One-way: cards go out to Cliq" : "Zoho Cliq is not set up")
            }
            if self.m.webhookSet && !self.m.changingWebhook {
                HStack(spacing: 8) {
                    Text("Webhook URL")
                    Spacer(minLength: 8)
                    Text("Set").foregroundStyle(.secondary)
                    Button("Change") { self.m.changingWebhook = true }.buttonStyle(SecondaryButtonStyle())
                }
            } else {
                HStack(spacing: 8) {
                    LabeledContent("Webhook URL") {
                        SecureField("Webhook URL", text: m.webhookDraft, prompt: Text("https://cliq.zoho.in/…"))
                            .textFieldStyle(.roundedBorder)
                    }
                    Button("Paste") { self.m.pasteWebhook() }.buttonStyle(SecondaryButtonStyle())
                }
                if !self.m.webhookDraft.trimmed.isEmpty && !self.m.webhookLooksValid {
                    Text("That should be an https link on zoho.com, like the one in the bot's webhook settings.")
                        .font(.caption).foregroundStyle(Theme.muted)
                }
                if self.m.webhookSet {
                    Button("Cancel") { self.m.webhookDraft = ""; self.m.changingWebhook = false }.buttonStyle(QuietButtonStyle())
                }
            }
            if self.m.restarting {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Restarting the Squeak service…").foregroundStyle(.secondary) }
            }
            if let n = self.m.notice { Footnote(n) }

            Footnote("The webhook sends cards to Cliq. Find it in the bot's webhook settings.")
        }
    }

    private func cliqOwner(m: Bindable<ChannelsModel>) -> some View {
        SettingsCard(title: "Owner", subtitle: "Choose who receives your agent updates.", symbol: "person.crop.circle.fill") {
            LabeledContent("Owner email") {
                TextField("Owner email", text: m.ownerEmail, prompt: Text("you@company.com"))
                    .textFieldStyle(.roundedBorder)
            }
            LabeledContent("Owner ID") {
                TextField("Owner ID", text: m.ownerId, prompt: Text("Cliq user ID"))
                    .textFieldStyle(.roundedBorder)
            }
            HStack(spacing: 8) {
                Button("Save") { Task { await self.m.saveCliq() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!self.m.cliqDirty || self.m.restarting || (!self.m.webhookDraft.trimmed.isEmpty && !self.m.webhookLooksValid))
                Spacer()
                if self.m.webhookSet {
                    Button("Remove webhook") { Task { await self.m.removeWebhook() } }.buttonStyle(DestructiveButtonStyle()).disabled(self.m.restarting)
                }
            }

            Footnote(self.m.cliqDirty ? "The owner email and ID say whose messages Squeak accepts. Saving restarts the Squeak service for a few seconds." : "The owner email and ID say whose messages Squeak accepts.")
        }
    }

    private var botLogo: some View {
        SettingsCard(title: "Bot logo", subtitle: "Give your bot a familiar face.", symbol: "photo.fill") {
            HStack(spacing: 12) {
                BotLogoPreview()
                Text("Bot logo")
                Spacer(minLength: 8)
                if m.savedLogo != nil {
                    Button("Reveal in Finder") { if let u = m.savedLogo { NSWorkspace.shared.activateFileViewerSelecting([u]) } }
                        .buttonStyle(QuietButtonStyle())
                }
                Button("Save logo…") { saveLogo() }.buttonStyle(SecondaryButtonStyle())
            }

            VStack(alignment: .leading, spacing: 4) {
                if let msg = m.logoMessage { Footnote(msg) }
                Footnote("Zoho blocks setting it from Squeak. In Cliq: Bots → Squeak → Edit → upload the picture, crop to the circle, and Save.")
            }
        }
    }

    private func saveLogo() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "squeak-bot-avatar.jpg"
        panel.allowedContentTypes = [.jpeg]
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url { m.saveBotLogo(to: url) }
    }

    private var twoWaySection: some View {
        SettingsCard(title: "Replies", subtitle: "Bring your answers back into the agent’s chat.", symbol: "arrowshape.turn.up.left.fill") { twoWay }
    }

    @ViewBuilder private var twoWay: some View {
        let on = m.channels?.cliq.twoWay == true
        VStack(alignment: .leading, spacing: 6) {
            Text(on ? "Replies from Cliq are on." : "To receive replies from Cliq, run this once in Terminal:")
                .font(.callout).foregroundStyle(.secondary)
            if !on {
                HStack(spacing: 8) {
                    Text(verbatim: ChannelsModel.relayCommand).font(Typo.code).textSelection(.enabled).lineLimit(2)
                    Spacer(minLength: 0)
                    Button(copied ? "Copied" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(ChannelsModel.relayCommand, forType: .string)
                        copied = true
                        Task { try? await Task.sleep(for: .seconds(2)); copied = false }
                    }.buttonStyle(SecondaryButtonStyle())
                }
                .padding(8)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                Text("It needs the iPhone channel's Firebase project, and prints the handlers to paste into the bot.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Link a chat

struct LinkChatSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    private var m: ChannelsModel { app.channels }

    var body: some View {
        let bot = m.channels?.telegram.botUsername
        VStack(alignment: .leading, spacing: 14) {
            Text("Link a chat").font(Typo.title)
            VStack(alignment: .leading, spacing: 4) {
                Text("1. Open Telegram and send any message to \(bot.map { "@\($0)" } ?? "your bot").")
                Text("2. Pick the chat below when it appears.")
            }
            .font(Typo.body).foregroundStyle(Theme.muted)
            if !(m.channels?.telegram.configured ?? m.demo) {
                Text("Save the bot token first, so Squeak can hear the bot.").font(.callout).foregroundStyle(Theme.muted)
            }
            Divider()
            if m.candidates.isEmpty {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Waiting for a message…").foregroundStyle(Theme.muted) }
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                VStack(spacing: 0) {
                    ForEach(m.candidates) { c in
                        HStack {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(c.name.isEmpty ? "Chat" : c.name).font(.system(size: 13, weight: .medium))
                                Text(verbatim: "\(c.type == "private" ? "Private chat" : c.type.capitalized) · ID \(c.id)")
                                    .font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
                            }
                            Spacer()
                            Button("Link") { m.link(c) }.buttonStyle(SecondaryButtonStyle())
                        }
                        .padding(.vertical, 6)
                        if c.id != m.candidates.last?.id { Hairline() }
                    }
                }
            }
            HStack { Spacer(); Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 420)
        .task { await m.pollCandidates() }
    }
}

// MARK: - iPhone tab

struct IPhoneSettings: View {
    @Environment(AppModel.self) private var app
    @State private var pairing = false
    @State private var settingUp = false
    @State private var setupFinished = false
    @State private var confirmReset = false
    @State private var revoking: RemoteStatus.Device?
    private var m: ChannelsModel { app.channels }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if m.remoteOutdated || !m.daemonReachable {
                SettingsCard(title: "Squeak service", subtitle: "Follow sessions and reply from your iPhone.", symbol: "iphone.gen3") {
                    StatusLine(dot: m.daemonReachable ? nil : Theme.needsYou,
                               text: m.daemonReachable ? "Update the Squeak service" : "Squeak service is off",
                               detail: m.daemonReachable ? "This service is older than the app and can't pair phones." : "Start it to see and pair iPhones.")
                }
            } else if m.remote == nil {
                SettingsCard(title: "Squeak service", subtitle: "Follow sessions and reply from your iPhone.", symbol: "iphone.gen3") { StatusLine(dot: nil, text: "Checking") }
            } else if !m.phoneEnabled {
                SettingsCard(title: "Squeak service", subtitle: "Follow sessions and reply from your iPhone.", symbol: "iphone.gen3") {
                    StatusLine(dot: nil, text: "The iPhone channel is off")
                    HStack { Button("Set up…") { settingUp = true }.buttonStyle(PrimaryButtonStyle()); Spacer() }

                    Footnote("Squeak for iPhone talks to this Mac through Firebase. Squeak can set up your own, or use its shared server.")
                }
            } else {
                enabledSections
            }
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await m.pollRemote() }
        .sheet(isPresented: $pairing, onDismiss: { m.endPairing() }) { PairSheet().environment(app) }
        .sheet(isPresented: $settingUp, onDismiss: {
            if setupFinished { setupFinished = false; pairing = true }
        }) {
            FirebaseSetupSheet(channels: m, finished: $setupFinished, movingFromShared: m.onSharedServer)
        }
        .confirmationDialog("Disconnect this iPhone?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), presenting: revoking) { d in
            Button("Disconnect \(d.name)", role: .destructive) { Task { await m.revoke(d.id) } }
        } message: { _ in
            Text("It stops getting sessions and can't reply. You can pair it again later.")
        }
        .confirmationDialog("Disconnect every iPhone?", isPresented: $confirmReset) {
            Button("Disconnect all and start over", role: .destructive) { Task { await m.resetPhones() } }
        } message: {
            Text("The old pairing code and every paired phone stop working.")
        }
    }

    private var sharedDetail: String? {
        if m.remote?.pausedUntil != nil { return "Paused until midnight. Your iPhone still works on the same Wi-Fi." }
        guard let used = m.remote?.usedBytes, let budget = m.remote?.budgetBytes, budget > 0 else { return nil }
        let f = ByteCountFormatter(); f.countStyle = .file
        return "Used \(f.string(fromByteCount: Int64(used))) of \(f.string(fromByteCount: Int64(budget))) today."
    }

    @ViewBuilder private var enabledSections: some View {
        let devices = m.remote?.activeDevices ?? []
        let pending = m.remote?.pending ?? []
        if m.onSharedServer {
            SettingsCard(title: "Server", subtitle: "Choose where your phone connects to this Mac.", symbol: "iphone.gen3") {
                StatusLine(dot: m.remote?.pausedUntil == nil ? nil : Theme.needsYou,
                           text: "On Squeak's shared server (limited)",
                           detail: sharedDetail)
                HStack { Button("Move to your own Firebase…") { settingUp = true }.buttonStyle(SecondaryButtonStyle()); Spacer() }

                Footnote("Moving means pairing your iPhone again.")
            }
        }
        if !pending.isEmpty {
            SettingsCard(title: "Waiting for you", subtitle: "Match the code on your phone before approving.", symbol: "person.crop.circle.badge.questionmark") {
                ForEach(pending) { PendingRow(request: $0) }

                Footnote("Approve only if the code matches the one on your iPhone.")
            }
        }
        SettingsCard(title: "Paired iPhones", subtitle: "Your trusted devices, connected to this Mac.", symbol: "iphone.gen3") {
            if devices.isEmpty {
                HStack(spacing: Space.m) {
                    Image(systemName: "iphone.gen3")
                        .font(.system(size: 19, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .background(Theme.muted.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No iPhone paired yet").font(Typo.label).foregroundStyle(Theme.ink)
                        Text("Pair your phone to keep up with sessions away from your Mac.")
                            .font(Typo.body).foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            ForEach(devices) { d in
                HStack(spacing: Space.m) {
                    Image(systemName: "iphone.gen3")
                        .font(.system(size: 17, weight: .medium)).foregroundStyle(Color(red: 0.45, green: 0.62, blue: 1.0))
                        .frame(width: 38, height: 38)
                        .background(Color(red: 0.45, green: 0.62, blue: 1.0).opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.control))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(d.name).font(Typo.label).foregroundStyle(Theme.ink)
                        if let at = d.pairedAt {
                            Text("Paired \(at.formatted(date: .abbreviated, time: .omitted))").font(Typo.meta).foregroundStyle(Theme.muted)
                        }
                    }
                    Spacer()
                    Button("Disconnect…") { revoking = d }.buttonStyle(DestructiveButtonStyle())
                }
            }
            HStack {
                // One primary per screen (§8.9): Approve wins while a request waits.
                Button("Pair an iPhone…") { pairing = true }
                    .modifier(PrimaryUnless(pending.isEmpty ? false : true))
                Spacer()
                if m.remote?.configured == true {
                    Button("Disconnect all…") { confirmReset = true }.buttonStyle(QuietButtonStyle())
                }
            }

            Footnote("Pairing always waits for you to approve it here. A paired iPhone can read your sessions and send replies.")
        }
        if let n = m.notice { SettingsCard(title: "Channel notice", subtitle: "The latest update from this connection.", symbol: "info.circle") { Footnote(n) } }
    }
}

private struct PrimaryUnless: ViewModifier {
    let demoted: Bool
    init(_ demoted: Bool) { self.demoted = demoted }
    func body(content: Content) -> some View {
        if demoted { content.buttonStyle(SecondaryButtonStyle()) } else { content.buttonStyle(PrimaryButtonStyle()) }
    }
}

struct PendingRow: View {
    @Environment(AppModel.self) private var app
    let request: RemoteStatus.Pending
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(request.name).font(.system(size: 13, weight: .medium))
                Text(verbatim: request.code).font(.system(size: 20, weight: .semibold, design: .monospaced)).monospacedDigit()
                    .accessibilityLabel("Code \(request.code.map(String.init).joined(separator: " "))")
            }
            Spacer()
            Button("Reject") { Task { await app.channels.reject(request.id) } }.buttonStyle(SecondaryButtonStyle())
            Button("Approve") { Task { await app.channels.approve(request.id) } }.buttonStyle(PrimaryButtonStyle())
        }
    }
}

// MARK: - Pair sheet

struct PairSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var copiedCode = false
    @State private var target: PairTarget
    // Offline captures use an inert, realistically sized payload, never a live pairing secret.
    private let previewPairingURL: String?
    private var m: ChannelsModel { app.channels }
    private var pairingURL: String? { app.demoMode ? previewPairingURL ?? m.pairingURL : m.pairingURL }
    private var qrText: String? { pairingURL.flatMap { target.qrText(pairingURL: $0) } }

    init(initialTarget: PairTarget = .app, previewPairingURL: String? = nil) {
        _target = State(initialValue: initialTarget)
        self.previewPairingURL = previewPairingURL
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(alignment: .leading, spacing: 20) {
                header
                Picker("Pair", selection: $target) {
                    ForEach(PairTarget.allCases) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().accessibilityLabel("What to pair")
                ScrollView {
                    let wide = geometry.size.width >= 700
                    let layout = wide ? AnyLayout(HStackLayout(alignment: .center, spacing: 28))
                        : AnyLayout(VStackLayout(alignment: .center, spacing: 24))
                    layout {
                        PairingCodeView(text: qrText, target: target, error: m.pairingError,
                                        size: min(360, geometry.size.width - 56, max(240, geometry.size.height - 288)))
                        instructions.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 4)
                    approval
                    if let error = m.pairingError {
                        Text(error).font(.callout).foregroundStyle(Theme.muted)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 12)
                    }
                }
                footer
            }
            .padding(28)
        }
        .frame(minWidth: 420, idealWidth: 780, maxWidth: 820, minHeight: 560, idealHeight: 650, maxHeight: 760)
        .background(Theme.bg)
        .task { await m.startPairing() }
        .task { await m.pollRemote() }
        .onDisappear { m.endPairing() }
        .onChange(of: target) { copiedCode = false }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 16) {
            DuckMark(width: 56)
                .frame(width: 76, height: 76)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 20))
            VStack(alignment: .leading, spacing: 5) {
                Text("Pair a phone").font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text("Your agents. Away from your desk.")
                    .font(.body).foregroundStyle(Theme.muted)
            }
        }
    }

    private var instructions: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text(target == .app ? "Take Squeak with you" : "Squeak in your browser")
                    .font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                Text(target == .app ? "Follow sessions and reply from your iPhone." : "Follow sessions and reply without installing an app.")
                    .font(.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if target == .app {
                step("1", title: "Open Squeak on iPhone", detail: "Choose Pair with a Mac, then scan this code. Your Camera app works too.")
                step("2", title: "Match the code and approve", detail: "Check that the code on your phone matches the one here on your Mac.")
            } else {
                step("1", title: "Scan with your camera", detail: "The code opens Squeak for Web in your browser.")
                step("2", title: "Match the code and approve", detail: "Check that the code in your browser matches the one here on your Mac.")
            }
            if pairingURL != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Button(action: copyPairingCode) {
                        Label(copiedCode ? "Copied" : target.copyLabel, systemImage: copiedCode ? "checkmark" : "doc.on.doc")
                    }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(qrText == nil)
                    if target == .web {
                        Text("Or open \(RemotePairing.webAppAddress) and paste the link.")
                            .font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    private func step(_ number: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number).font(.callout.weight(.semibold)).foregroundStyle(Theme.ink)
                .frame(width: 28, height: 28).background(Theme.surfaceRaised, in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                Text(detail).font(.callout).foregroundStyle(Theme.muted)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var approval: some View {
        let pending = m.remote?.pending ?? []
        if !pending.isEmpty {
            Divider().padding(.vertical, 14)
            ForEach(pending) { PendingRow(request: $0) }
        } else if let paired = m.remote?.activeDevices.last, pairingURL != nil,
                  paired.pairedAt.map({ Date().timeIntervalSince($0) < 120 }) == true {
            Divider().padding(.vertical, 14)
            Label("\(paired.name) is paired.", systemImage: "checkmark.circle")
                .foregroundStyle(Theme.muted)
        }
    }

    private var footer: some View {
        HStack(alignment: .center, spacing: 20) {
            Label {
                Text("Keep this code private. You approve every pairing on this Mac.")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "lock.shield").accessibilityHidden(true)
            }
            .font(.caption).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Done") { dismiss() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        }
        .padding(.top, 16)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func copyPairingCode() {
        guard let text = pairingURL.flatMap({ target.copyText(pairingURL: $0) }) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copiedCode = true
        Task { try? await Task.sleep(for: .seconds(2)); copiedCode = false }
    }
}

private struct PairingCodeView: View {
    @Environment(\.displayScale) private var displayScale
    let text: String?
    let target: PairTarget
    let error: String?
    let size: CGFloat

    var body: some View {
        VStack(spacing: 14) {
            Group {
                if let text, let image = QRCode.image(for: text, points: size - 24, displayScale: displayScale) {
                    // Keep the exact raster size: each module occupies an integer number of backing pixels.
                    Image(nsImage: image).interpolation(.none)
                        .frame(width: image.size.width, height: image.size.height)
                        .accessibilityLabel(target == .app ? "Pairing QR code for the iPhone app" : "Pairing QR code for Squeak for Web")
                        .accessibilityHint("Scan with your phone, or use the copy button.")
                } else if error != nil {
                    Label("Code unavailable", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(Color.black)
                } else {
                    ProgressView("Preparing pairing code…").tint(.black).foregroundStyle(Color.black)
                }
            }
            .frame(width: size, height: size)
            .background(Color.white, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Theme.lineStrong))
            Label("Scan to pair", systemImage: "qrcode.viewfinder")
                .font(.callout.weight(.medium)).foregroundStyle(Theme.muted)
                .accessibilityHidden(true)
        }
    }
}

// MARK: - QR

enum QRCode {
    /// Includes a four-module white quiet zone; every module occupies whole backing pixels.
    static func image(for text: String, points: CGFloat, displayScale: CGFloat) -> NSImage? {
        guard points > 0, displayScale > 0 else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let extent = output.extent.insetBy(dx: -4, dy: -4)
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: extent)
        let padded = output.composited(over: white)
        let scale = max(1, (points * displayScale / extent.width).rounded(.down))
        let scaled = padded.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = CIContext(options: [.useSoftwareRenderer: true]).createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / displayScale, height: CGFloat(cg.height) / displayScale))
    }
}
