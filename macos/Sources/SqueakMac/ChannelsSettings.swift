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
        Form {
            telegramStatus
            telegramToken(m: $m)
            allowedChats
            botPicture
            telegramActions
        }
        .formStyle(.grouped)
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
        Section {
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
        } header: { Text("Status") }
    }

    private func telegramToken(m: Bindable<ChannelsModel>) -> some View {
        Section {
            if self.m.tokenSet && !self.m.changingToken {
                HStack(spacing: 8) {
                    Text("Bot token")
                    Spacer(minLength: 8)
                    Text("Set").foregroundStyle(.secondary)
                    Button("Change") { self.m.changingToken = true }.buttonStyle(SecondaryButtonStyle())
                }
            } else {
                HStack(spacing: 8) {
                    SecureField("Bot token", text: m.tokenDraft, prompt: Text("123456789:ABC…")).multilineTextAlignment(.trailing)
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
        } footer: {
            Footnote("Create a bot with @BotFather, then paste its token here. The token stays on this Mac, in Squeak's settings file, and is never shown again.")
        }
    }

    private var allowedChats: some View {
        Section {
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
        } header: { Text("Allowed chats") } footer: {
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
        Section {
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
        } footer: {
            if let line = BotAvatarText.line(m.avatarState) {
                Text(line).font(.callout).foregroundStyle(m.avatarState.isError ? Theme.needsYou : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            } else if !m.tokenSet {
                Footnote("Set the bot token first.")
            }
        }
    }

    private var telegramActions: some View {
        Section {
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
        } footer: {
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
        Form {
            cliqConnection(m: $m)
            cliqOwner(m: $m)
            botLogo
            twoWaySection
        }
        .formStyle(.grouped)
        .task { await m.refresh() }
    }

    private func cliqConnection(m: Bindable<ChannelsModel>) -> some View {
        Section {
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
                    SecureField("Webhook URL", text: m.webhookDraft, prompt: Text("https://cliq.zoho.in/…")).multilineTextAlignment(.trailing)
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
        } header: { Text("Webhook") } footer: {
            Footnote("The webhook sends cards to Cliq. Find it in the bot's webhook settings.")
        }
    }

    private func cliqOwner(m: Bindable<ChannelsModel>) -> some View {
        Section {
            TextField("Owner email", text: m.ownerEmail, prompt: Text("you@company.com")).multilineTextAlignment(.trailing)
            TextField("Owner ID", text: m.ownerId, prompt: Text("Cliq user ID")).multilineTextAlignment(.trailing)
            HStack(spacing: 8) {
                Button("Save") { Task { await self.m.saveCliq() } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!self.m.cliqDirty || self.m.restarting || (!self.m.webhookDraft.trimmed.isEmpty && !self.m.webhookLooksValid))
                Spacer()
                if self.m.webhookSet {
                    Button("Remove webhook") { Task { await self.m.removeWebhook() } }.buttonStyle(DestructiveButtonStyle()).disabled(self.m.restarting)
                }
            }
        } header: { Text("Owner") } footer: {
            Footnote(self.m.cliqDirty ? "The owner email and ID say whose messages Squeak accepts. Saving restarts the Squeak service for a few seconds." : "The owner email and ID say whose messages Squeak accepts.")
        }
    }

    private var botLogo: some View {
        Section {
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
        } header: { Text("Logo") } footer: {
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
        Section { twoWay } header: { Text("Replies") }
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
                Text("It needs the iPhone channel's Firebase project, and prints the handlers to paste into the bot. The steps are in docs/cliq.md.")
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
    @State private var confirmReset = false
    @State private var revoking: RemoteStatus.Device?
    private var m: ChannelsModel { app.channels }

    var body: some View {
        Form {
            if m.remoteOutdated || !m.daemonReachable {
                Section {
                    StatusLine(dot: m.daemonReachable ? nil : Theme.needsYou,
                               text: m.daemonReachable ? "Update the Squeak service" : "Squeak service is off",
                               detail: m.daemonReachable ? "This service is older than the app and can't pair phones." : "Start it to see and pair iPhones.")
                } header: { Text("Squeak for iPhone") }
            } else if m.remote == nil {
                Section { StatusLine(dot: nil, text: "Checking") } header: { Text("Squeak for iPhone") }
            } else if !m.phoneEnabled {
                Section {
                    StatusLine(dot: nil, text: "The iPhone channel is off")
                } header: { Text("Squeak for iPhone") } footer: {
                    Footnote("Squeak for iPhone talks to this Mac through a Firebase project you own. To turn it on, add SQUEAK_REMOTE_PROJECT=<your project id> to Squeak's settings file, then restart the Squeak service. docs/remote-channel.md has the steps.")
                }
            } else {
                enabledSections
            }
        }
        .formStyle(.grouped)
        .task { await m.pollRemote() }
        .sheet(isPresented: $pairing, onDismiss: { m.endPairing() }) { PairSheet().environment(app) }
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

    @ViewBuilder private var enabledSections: some View {
        let devices = m.remote?.activeDevices ?? []
        let pending = m.remote?.pending ?? []
        if !pending.isEmpty {
            Section {
                ForEach(pending) { PendingRow(request: $0) }
            } header: { Text("Waiting for you") } footer: {
                Footnote("Approve only if the code matches the one on your iPhone.")
            }
        }
        Section {
            if devices.isEmpty {
                Text("No iPhone is paired").foregroundStyle(.secondary)
            }
            ForEach(devices) { d in
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(d.name).font(.system(size: 13, weight: .medium))
                        if let at = d.pairedAt {
                            Text("Paired \(at.formatted(date: .abbreviated, time: .omitted))").font(.caption).foregroundStyle(.secondary)
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
        } header: { Text("Paired iPhones") } footer: {
            Footnote("Pairing always waits for you to approve it here. A paired iPhone can read your sessions and send replies.")
        }
        if let n = m.notice { Section { Footnote(n) } }
    }
}

private struct PrimaryUnless: ViewModifier {
    let demoted: Bool
    init(_ demoted: Bool) { self.demoted = demoted }
    func body(content: Content) -> some View {
        if demoted { content.buttonStyle(SecondaryButtonStyle()) } else { content.buttonStyle(PrimaryButtonStyle()) }
    }
}

private struct PendingRow: View {
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
    private var m: ChannelsModel { app.channels }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Pair an iPhone").font(Typo.title)
            HStack(alignment: .top, spacing: 20) {
                qr
                VStack(alignment: .leading, spacing: 6) {
                    Text("1. Open Squeak on your iPhone.")
                    Text("2. Choose Pair with a Mac, then scan this code.")
                    Text("3. Check the code on the phone matches the one here, then approve.")
                    if m.pairingURL != nil {
                        VStack(alignment: .leading, spacing: 4) {
                            Button(copiedCode ? "Copied" : "Copy pairing code") {
                                guard m.copyPairingCode() else { return }
                                copiedCode = true
                                Task { try? await Task.sleep(for: .seconds(2)); copiedCode = false }
                            }.buttonStyle(SecondaryButtonStyle())
                            Text("For Squeak for Web, paste it at \(RemotePairing.webAppAddress)")
                                .font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 6)
                    }
                }
                .font(Typo.body).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            }
            let pending = m.remote?.pending ?? []
            if !pending.isEmpty {
                Divider()
                ForEach(pending) { PendingRow(request: $0) }
            } else if let paired = m.remote?.activeDevices.last, m.pairingURL != nil, paired.pairedAt.map({ Date().timeIntervalSince($0) < 120 }) == true {
                Divider()
                HStack(spacing: 6) { Lucide(.check, size: 14, color: Theme.muted); Text("\(paired.name) is paired.").foregroundStyle(Theme.muted) }
            }
            if let e = m.pairingError { Text(e).font(.callout).foregroundStyle(Theme.muted) }
            HStack {
                Text("Keep this code private. Anyone who scans it can ask to pair, and you still approve.")
                    .font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                Button("Done") { dismiss() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 500)
        .task { await m.startPairing() }
        .task { await m.pollRemote() }
        .onDisappear { m.endPairing() }
    }

    @ViewBuilder private var qr: some View {
        Group {
            if let url = m.pairingURL, let image = QRCode.image(for: url, points: 176) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: image.size.width, height: image.size.height)
                    .accessibilityLabel("Pairing code for your iPhone")
            } else if m.pairingError != nil {
                Lucide(.circleAlert, size: 24, color: Theme.subtle)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .frame(width: 176, height: 176)
        .padding(12)
        // A QR needs a light ground in either appearance.
        .background(Color.white, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.lineStrong))
    }
}

// MARK: - QR

enum QRCode {
    /// A QR image scaled by whole pixels per module, so its edges stay hard.
    static func image(for text: String, points: CGFloat) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let modules = output.extent.width
        let backing = NSScreen.main?.backingScaleFactor ?? 2
        let scale = max(1, (points * backing / modules).rounded(.down))
        let scaled = output.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = CIContext(options: [.useSoftwareRenderer: true]).createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: CGFloat(cg.width) / backing, height: CGFloat(cg.height) / backing))
    }
}
