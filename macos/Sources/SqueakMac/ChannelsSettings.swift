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
            .foregroundStyle(Theme.negative)
            .padding(.horizontal, 12)
            .frame(minHeight: 28)
            .background(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .opacity(isEnabled ? 1 : 0.5)
            .pressFeedback(configuration.isPressed)
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
                StatusLine(dot: Theme.negative, text: "Squeak service is off", detail: "Changes are saved, and take effect when the service starts.")
            } else if m.channelsOutdated {
                StatusLine(dot: nil, text: "Update the Squeak service", detail: "This service is older than the app and can't report channel status. Saving still works.")
            } else if let t = m.channels?.telegram {
                switch (t.configured, t.polling) {
                case (false, _): StatusLine(dot: nil, text: "Telegram is not set up")
                case (true, .ok): StatusLine(dot: Theme.success, text: t.botUsername.map { "Connected as @\($0)" } ?? "Connected")
                case (true, .error): StatusLine(dot: Theme.negative, text: "Telegram is not connecting", detail: t.lastError)
                case (true, .off): StatusLine(dot: nil, text: "Telegram is off")
                }
            } else {
                StatusLine(dot: nil, text: "Checking")
            }
            if m.daemonReachable, !m.channelsOutdated, let t = m.channels?.telegram, t.configured, t.polling == .error {
                ReportProblemButton(problem: "Telegram is not connecting" + (t.lastError.map { ": \($0)" } ?? ""), place: "Settings › Channels › Telegram")
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
                Text(line).font(.callout).foregroundStyle(m.avatarState.isError ? Theme.negative : .secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                if m.avatarState.isError { ReportProblemButton(problem: line, place: "Settings › Channels › Telegram › Bot photo") }
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

            if let r = m.testResult {
                Footnote(r)
                if r.hasPrefix("Not sent") { ReportProblemButton(problem: r, place: "Settings › Channels › Telegram") }
            } else if m.telegramDirty { Footnote("Saving restarts the Squeak service for a few seconds.") }
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
            Text("Squeak talks to Zoho Cliq through a bot you create in Cliq. It posts a card when an agent is waiting for you or finishes, and your taps and replies come back to the agent.")
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
        SettingsCard(title: "Replies", subtitle: "Bring your answers back into the agent’s chat.", symbol: "arrowshape.turn.up.left.fill") {
            CliqHandlersSetup()
        }
    }
}

/// The guided setup for replies: copy each handler, paste it where the step says, then tap a button in Cliq.
struct CliqHandlersSetup: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var feedback = CopyButtons()
    @State private var confirmRegenerate = false
    private var m: ChannelsModel { app.channels }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch CliqSetupModel.page(m.cliqHandlers, outdated: m.cliqHandlersOutdated) {
            case .outdated:
                Text("Update Squeak's service to set up replies from here.").font(.callout).foregroundStyle(.secondary)
            case .loading:
                ProgressView().controlSize(.small)
            case .ready:
                ForEach(CliqSetupModel.steps(m.cliqHandlers ?? CliqHandlersView())) { step in stepCard(step) }
                checkCard
                HStack {
                    Spacer()
                    Button("Regenerate handlers") { confirmRegenerate = true }
                        .buttonStyle(QuietButtonStyle()).disabled(m.cliqPreparing)
                }
            case .gettingKey:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Getting your Cliq key from Squeak's cloud…").font(.callout).foregroundStyle(.secondary)
                }
            case .failed(let reason):
                Text(reason).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("Retry") { Task { await m.retryCliqHandlers() } }
                        .buttonStyle(PrimaryButtonStyle()).disabled(m.cliqPreparing)
                    if m.cliqPreparing { ProgressView().controlSize(.small) }
                }
            case .needsHandlers:
                Text("Squeak makes three small handlers for your Cliq bot. You copy each one into Cliq; nothing to type here.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("Make the handlers") { Task { await m.regenerateCliqHandlers() } }
                        .buttonStyle(PrimaryButtonStyle()).disabled(m.cliqPreparing || m.cliqHandlers == nil)
                    if m.cliqPreparing { ProgressView().controlSize(.small) }
                }
            }
            if let n = m.cliqSetupNotice { Footnote(n) }
            if let key = m.cliqRelayKey { relayKeyRow(key) }
        }
        .task {
            // Poll while the page is open so the check ticks as soon as the first tap arrives.
            while !Task.isCancelled {
                await m.loadCliqHandlers()
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .confirmationDialog("Regenerate the handlers?", isPresented: $confirmRegenerate) {
            Button("Regenerate", role: .destructive) { Task { await m.regenerateCliqHandlers() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Old handlers stop working until you paste the new ones.")
        }
    }

    private func stepCard(_ step: CliqSetupStep) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Step \(step.number): \(step.title)").font(Typo.label)
                Spacer(minLength: 8)
                Button("Open Zoho Cliq") { openURL(CliqSetupModel.cliqURL) }.buttonStyle(QuietButtonStyle())
            }
            Text("Paste into: \(step.place)").font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            ScrollView {
                Text(verbatim: step.code).font(Typo.code).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            .frame(height: 110)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            TimelineView(.periodic(from: .now, by: 0.25)) { context in
                Button(feedback.label(step.id, at: context.date)) { copy(step) }
                    .buttonStyle(PrimaryButtonStyle())
            }
        }
        .padding(12)
        .background(Theme.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    private var checkCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Step 4: Check").font(Typo.label)
            Text("Tap any button on a Squeak card in Cliq.").font(.callout).foregroundStyle(.secondary)
            switch m.cliqTapStatus {
            case .waiting:
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Waiting for your first tap…").foregroundStyle(.secondary) }
            case .received:
                Label("Your tap arrived. Replies from Cliq work.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case .alreadyWorking:
                Label("Replies from Cliq are working.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            }
        }
        .padding(12)
        .background(Theme.surface.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    private func relayKeyRow(_ key: String) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: key).font(Typo.code).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
            TimelineView(.periodic(from: .now, by: 0.25)) { context in
                Button(feedback.label("key", at: context.date)) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(key, forType: .string)
                    feedback.press("key")
                }.buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(8)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
    }

    private func copy(_ step: CliqSetupStep) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(step.code, forType: .string)
        feedback.press(step.id)
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
    @State private var confirmReset = false
    @State private var revoking: DeviceRow?
    @State private var confirmUnlink = false
    private var m: ChannelsModel { app.channels }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            if m.remoteOutdated || !m.daemonReachable {
                SettingsCard(title: "Squeak service", subtitle: "Follow sessions and reply from your iPhone.", symbol: "iphone.gen3") {
                    StatusLine(dot: m.daemonReachable ? nil : Theme.negative,
                               text: m.daemonReachable ? "Update the Squeak service" : "Squeak service is off",
                               detail: m.daemonReachable ? "This service is older than the app and can't add phones." : "Start it to see your devices.")
                }
            } else if m.remote == nil {
                SettingsCard(title: "Squeak service", subtitle: "Follow sessions and reply from your iPhone.", symbol: "iphone.gen3") { StatusLine(dot: nil, text: "Checking") }
            } else if !m.phoneEnabled {
                SettingsCard(title: "Squeak service", subtitle: "Follow sessions and reply from your iPhone.", symbol: "iphone.gen3") {
                    if let h = app.cloud.hosted, let line = h.statusSentence(accountKnown: app.account.email != nil) {
                        StatusLine(dot: nil, text: "The iPhone channel is off", detail: line)
                        HStack {
                            Button(app.account.email != nil ? "Open Account" : "Sign in…") {
                                if app.account.email != nil { app.openSettingsInPlace(.account) } else { app.account.openSignIn(from: .settings) }
                            }.buttonStyle(PrimaryButtonStyle())
                            Spacer()
                        }
                        if let l = h.legacySentence(accountKnown: app.account.email != nil) { Footnote(l) }
                    } else {
                        StatusLine(dot: nil, text: "The iPhone channel is off")
                        Footnote("Update the Squeak service on this Mac to set it up.")
                    }
                }
            } else {
                enabledSections
            }
        }
        .toggleStyle(.switch)
        .padding(.horizontal, 24)
        .padding(.bottom, 28)
        .task { await m.pollRemote() }
        .confirmationDialog("Remove this device?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }), presenting: revoking) { d in
            Button("Remove \(d.name)", role: .destructive) { Task { await m.revoke(d.id) } }
        } message: { d in
            Text(DeviceList.removeMessage(name: d.name))
        }
        .confirmationDialog("Unlink your Squeak account?", isPresented: $confirmUnlink) {
            Button("Unlink", role: .destructive) { Task { await m.unlinkAccount() } }
        } message: {
            Text("Browsers and iPhones signed in to \(m.remote?.account?.email ?? "this account") will no longer see this Mac. Devices already added keep working.")
        }
        .confirmationDialog("Remove every device?", isPresented: $confirmReset) {
            Button("Remove all", role: .destructive) { Task { await m.resetPhones() } }
        } message: {
            Text("Every iPhone and browser stops getting sessions. Signing in on one adds it back.")
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
        if let h = app.cloud.hosted, let line = h.statusSentence(accountKnown: app.account.email != nil) {
            SettingsCard(title: "Squeak cloud", subtitle: "How your iPhone reaches this Mac.", symbol: "iphone.gen3") {
                StatusLine(dot: h.isReady ? Theme.info : nil, text: line)
                if let l = h.legacySentence(accountKnown: app.account.email != nil) { Footnote(l) }
            }
        }
        if !pending.isEmpty {
            SettingsCard(title: "Waiting for you", subtitle: "Devices of your own account that want to open this Mac.", symbol: "person.crop.circle.badge.questionmark") {
                ForEach(pending) { PendingRow(request: $0) }
                Footnote("One click lets it in. Reject if it isn't yours.")
            }
        }
        SettingsCard(title: "Your devices", subtitle: "The iPhones and browsers signed in to your account.", symbol: "iphone.gen3") {
            let rows = DeviceList.rows(devices)
            if rows.isEmpty {
                HStack(spacing: Space.m) {
                    Image(systemName: "iphone.gen3")
                        .font(.system(size: 19, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(width: 40, height: 40)
                        .background(Theme.muted.opacity(0.12), in: RoundedRectangle(cornerRadius: Radius.control))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No devices yet").font(Typo.label).foregroundStyle(Theme.ink)
                        Text(DeviceList.emptyLine(accountEmail: app.account.email))
                            .font(Typo.body).foregroundStyle(Theme.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                if app.account.email == nil {
                    HStack {
                        Button("Sign in…") { app.account.openSignIn(from: .settings) }.buttonStyle(PrimaryButtonStyle())
                        Spacer()
                    }
                }
            }
            ForEach(rows) { row in
                HStack(spacing: Space.m) {
                    Image(systemName: row.kind.symbol)
                        .font(.system(size: 17, weight: .medium)).foregroundStyle(Color(red: 0.45, green: 0.62, blue: 1.0))
                        .frame(width: 38, height: 38)
                        .background(Color(red: 0.45, green: 0.62, blue: 1.0).opacity(0.14), in: RoundedRectangle(cornerRadius: Radius.control))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(row.name).font(Typo.label).foregroundStyle(Theme.ink)
                        Text(row.line).font(Typo.meta).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    Button("Remove…") { revoking = row }.buttonStyle(DestructiveButtonStyle())
                }
            }
            if m.remote?.configured == true, !rows.isEmpty {
                HStack {
                    Spacer()
                    Button("Remove all…") { confirmReset = true }.buttonStyle(QuietButtonStyle())
                }
            }

            if let account = m.remote?.account {
                HStack(spacing: Space.m) {
                    Text("Linked account:").font(Typo.label).foregroundStyle(Theme.ink)
                    Text(verbatim: account.email).font(Typo.body).foregroundStyle(Theme.muted).textSelection(.enabled)
                    Spacer()
                    Button("Unlink…") { confirmUnlink = true }.buttonStyle(DestructiveButtonStyle())
                }
                .accessibilityElement(children: .contain)
            }

            Footnote(DeviceList.footnote())
        }
        if let n = m.notice { SettingsCard(title: "Channel notice", subtitle: "The latest update from this connection.", symbol: "info.circle") { Footnote(n) } }
    }
}

struct PendingRow: View {
    @Environment(AppModel.self) private var app
    let request: RemoteStatus.Pending
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                if request.isAccountRequest {
                    Text(verbatim: request.email.map { "\(request.name) · \($0)" } ?? request.name).font(.system(size: 13, weight: .medium))
                    Text("Signed in to your Squeak account").font(Typo.meta).foregroundStyle(Theme.muted)
                } else {
                    // A request from an older phone that still pairs by QR code: the code is how you know it is yours.
                    Text(request.name).font(.system(size: 13, weight: .medium))
                    Text(verbatim: request.code).font(.system(size: 20, weight: .semibold, design: .monospaced)).monospacedDigit()
                        .accessibilityLabel("Code \(request.code.map(String.init).joined(separator: " "))")
                    Text("Approve only if this matches your phone").font(Typo.meta).foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            Button("Reject") { Task { await app.channels.reject(request.id) } }.buttonStyle(SecondaryButtonStyle())
            Button("Approve") { Task { await app.channels.approve(request.id) } }.buttonStyle(PrimaryButtonStyle())
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
