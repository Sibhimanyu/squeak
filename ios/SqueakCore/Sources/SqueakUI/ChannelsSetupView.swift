#if os(iOS)
import SqueakCore
import SwiftUI
import UIKit

/// Settings › Channels: Telegram and Zoho Cliq setup, as on the Mac (Settings › Channels). The Mac owns everything
/// (`channelsSetup` in the phone view); every change but a test and the link window asks Face ID or the passcode
/// first, and a token or webhook is typed or pasted, sent once, and gone from this view at once.
struct ChannelsSetupView: View {
    @Environment(AppModel.self) private var model
    /// The line under the page: the Mac's refusal, or the restart note after a save.
    @State private var note: String?

    private var setup: ChannelsSetup? { model.snapshot?.channelsSetup }

    var body: some View {
        Form {
            if case .silent = model.macLiveness() {
                Section { Text("Your Mac isn't answering. Changes won't reach it.").font(.footnote).foregroundStyle(Theme.muted) }
            }
            if let setup {
                if setup.restarting == true {
                    Section {
                        HStack(spacing: 8) { ProgressView(); Text("Restarting the Squeak service…").foregroundStyle(Theme.muted) }
                    }
                }
                if let telegram = setup.telegram {
                    TelegramSetupSections(telegram: telegram, restarting: setup.restarting == true, note: $note)
                }
                if let cliq = setup.cliq {
                    CliqSetupSections(cliq: cliq, note: $note)
                }
                if let note {
                    Section { Text(note).font(.footnote).foregroundStyle(Theme.muted) }
                }
            } else {
                Section { Text("Channel setup needs a newer Squeak on your Mac.").font(.footnote).foregroundStyle(Theme.muted) }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Channels")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
    }
}

/// Runs one change and sets the page's line: the Mac's reason, or the restart note after a save.
@MainActor
private func run(_ note: Binding<String?>, busy: Binding<Bool>, restarts: Bool, _ work: @escaping () async -> String?) {
    note.wrappedValue = nil
    busy.wrappedValue = true
    Task {
        let problem = await work()
        busy.wrappedValue = false
        note.wrappedValue = problem ?? (restarts ? ChannelsSetupFormat.restartNote : nil)
    }
}

private struct TelegramSetupSections: View {
    @Environment(AppModel.self) private var model
    let telegram: ChannelsSetup.Telegram
    let restarting: Bool
    @Binding var note: String?

    /// The secret being typed. Cleared the moment it is handed to `send`; never read by anything else.
    @State private var tokenDraft = ""
    @State private var changingToken = false
    @State private var busy = false
    @State private var confirmOff = false
    @State private var pictureLine: String?
    @State private var pictureBusy = false
    @FocusState private var tokenFocused: Bool

    private var tokenSet: Bool { telegram.tokenSet == true }
    private var draftTrimmed: String { ChannelsSetupFormat.trimmed(tokenDraft) }
    private var showTokenField: Bool { !tokenSet || changingToken }
    private var linkingNow: Bool { telegram.linking != nil }

    var body: some View {
        statusSection
        tokenSection
        if tokenSet {
            chatsSection
            if model.snapshot?.telegramAvatar == true { pictureSection }
            testSection
        }
    }

    private var statusSection: some View {
        let s = ChannelsSetupFormat.telegramStatus(telegram, restarting: restarting)
        return Section {
            HStack(alignment: .top, spacing: 10) {
                Circle().fill(tint(s.tint)).frame(width: 8, height: 8).padding(.top, 6).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.text)
                    if let detail = s.detail { Text(detail).font(.footnote).foregroundStyle(Theme.muted) }
                }
            }
            .frame(minHeight: 44)
            if telegram.open == true && tokenSet {
                Text(ChannelsSetupFormat.openWarning).font(.footnote).foregroundStyle(Theme.muted)
            }
        } header: { Label("Telegram · Status", systemImage: "paperplane") }
    }

    private func tint(_ name: String?) -> Color {
        switch name {
        case "ok": Theme.working
        case "error": Theme.error
        default: Theme.idle
        }
    }

    private var tokenSection: some View {
        Section {
            if showTokenField {
                SecureField("Bot token", text: $tokenDraft, prompt: Text("123456789:ABC…"))
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($tokenFocused)
                    .frame(minHeight: 44)
                Button("Paste") { if let s = UIPasteboard.general.string { tokenDraft = s } }.frame(minHeight: 44)
                if !draftTrimmed.isEmpty && !ChannelsSetupFormat.isBotToken(draftTrimmed) {
                    Text(ChannelsSetupFormat.badToken).font(.footnote).foregroundStyle(Theme.muted)
                }
                Button("Save") { save() }
                    .disabled(busy || restarting || !ChannelsSetupFormat.isBotToken(draftTrimmed))
                    .frame(minHeight: 44)
                if changingToken {
                    Button("Cancel") { tokenDraft = ""; changingToken = false }.foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
            } else {
                HStack {
                    Text("Bot token")
                    Spacer()
                    Text("Set").foregroundStyle(Theme.muted)
                }
                .frame(minHeight: 44)
                Button("Change") { changingToken = true; tokenFocused = true }.frame(minHeight: 44)
            }
        } header: { Text("Bot token") } footer: {
            Text("Connect the Telegram bot you want Squeak to use. \(ChannelsSetupFormat.restartNote)")
        }
    }

    private func save() {
        let secret = draftTrimmed
        tokenDraft = ""
        changingToken = false
        tokenFocused = false
        run($note, busy: $busy, restarts: true) { await model.changeTelegram(.token(secret)) }
    }

    private var chatsSection: some View {
        Section {
            let chats = telegram.chats ?? []
            if chats.isEmpty { Text(ChannelsSetupFormat.noChats).foregroundStyle(Theme.muted).frame(minHeight: 44) }
            ForEach(chats) { chat in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ChannelsSetupFormat.chatName(chat))
                        Text(verbatim: "ID \(chat.id)").font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
                    }
                    Spacer()
                    Button {
                        run($note, busy: $busy, restarts: true) { await model.changeTelegram(.unlink(chat.id)) }
                    } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.muted) }
                        .buttonStyle(.borderless)
                        .disabled(busy || restarting)
                        .accessibilityLabel("Remove \(ChannelsSetupFormat.chatName(chat))")
                }
                .frame(minHeight: 44)
            }
            if let linking = telegram.linking {
                ForEach(ChannelsSetupFormat.linkSteps(bot: telegram.bot), id: \.self) { Text($0).font(.footnote).foregroundStyle(Theme.muted) }
                let linked = Set(chats.map(\.id))
                let candidates = linking.candidates.filter { !linked.contains($0.id) }
                if candidates.isEmpty {
                    HStack(spacing: 8) { ProgressView(); Text(ChannelsSetupFormat.waiting).foregroundStyle(Theme.muted) }.frame(minHeight: 44)
                }
                ForEach(candidates) { c in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(c.name.isEmpty ? "Chat" : c.name)
                            Text(ChannelsSetupFormat.candidateDetail(c)).font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
                        }
                        Spacer()
                        Button("Link") { run($note, busy: $busy, restarts: true) { await model.changeTelegram(.link(c.id)) } }
                            .disabled(busy || restarting)
                    }
                    .frame(minHeight: 44)
                }
                Button("Done") { run($note, busy: $busy, restarts: false) { await model.changeTelegram(.stopLink) } }
                    .frame(minHeight: 44)
            } else {
                Button("Link a chat…") { run($note, busy: $busy, restarts: false) { await model.changeTelegram(.startLink) } }
                    .disabled(busy || restarting)
                    .frame(minHeight: 44)
            }
        } header: { Text("Allowed chats") } footer: { Text("Choose who can talk to your bot.") }
    }

    private var pictureSection: some View {
        Section {
            Button {
                pictureBusy = true
                pictureLine = nil
                Task {
                    pictureLine = await model.setTelegramAvatar()
                    pictureBusy = false
                }
            } label: {
                HStack { Text("Use Squeak logo"); Spacer(); if pictureBusy { ProgressView() } }
            }
            .disabled(pictureBusy)
            .frame(minHeight: 44)
            if let pictureLine { Text(pictureLine).font(.footnote).foregroundStyle(Theme.muted) }
        } header: { Text("Bot picture") } footer: { Text(ChannelsSetupFormat.pictureDetail) }
    }

    private var testSection: some View {
        Section {
            Button {
                run($note, busy: $busy, restarts: false) { await model.changeTelegram(.test) }
            } label: {
                HStack { Text(busy || telegram.testing == true ? "Sending…" : "Send test message"); Spacer() }
            }
            .disabled(busy || telegram.testing == true || restarting)
            .frame(minHeight: 44)
            if let test = telegram.lastTest {
                Text(ChannelsSetupFormat.testLine(test)).font(.footnote).foregroundStyle(test.ok ? Theme.muted : Theme.needsYou)
            }
            Button("Turn off…", role: .destructive) { confirmOff = true }
                .disabled(busy || restarting)
                .frame(minHeight: 44)
        } header: { Text("Save & test") } footer: { Text("Apply your changes, then check the connection.") }
        .confirmationDialog(ChannelsSetupFormat.turnOffTitle, isPresented: $confirmOff, titleVisibility: .visible) {
            Button(ChannelsSetupFormat.turnOffButton, role: .destructive) {
                run($note, busy: $busy, restarts: true) { await model.changeTelegram(.off) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text(ChannelsSetupFormat.turnOffMessage) }
    }
}

private struct CliqSetupSections: View {
    @Environment(AppModel.self) private var model
    let cliq: ChannelsSetup.Cliq
    @Binding var note: String?

    /// The secret being typed; cleared the moment it is handed to `save`.
    @State private var webhookDraft = ""
    @State private var changingWebhook = false
    @State private var email: String?
    @State private var ownerId: String?
    @State private var busy = false
    @State private var confirmRemove = false

    private var webhookSet: Bool { cliq.webhookSet == true }
    private var draftTrimmed: String { ChannelsSetupFormat.trimmed(webhookDraft) }
    private var showField: Bool { !webhookSet || changingWebhook }
    private var emailText: Binding<String> { Binding(get: { email ?? cliq.ownerEmail ?? "" }, set: { email = $0 }) }
    private var idText: Binding<String> { Binding(get: { ownerId ?? cliq.ownerId ?? "" }, set: { ownerId = $0 }) }
    private var ownerDirty: Bool { emailText.wrappedValue != (cliq.ownerEmail ?? "") || idText.wrappedValue != (cliq.ownerId ?? "") }

    var body: some View {
        webhookSection
        ownerSection
        if webhookSet { repliesSection }
    }

    private var webhookSection: some View {
        Section {
            Label(ChannelsSetupFormat.cliqStatus(cliq), systemImage: "bubble.left").frame(minHeight: 44)
            if showField {
                SecureField("Webhook URL", text: $webhookDraft, prompt: Text("https://cliq.zoho.in/…"))
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .frame(minHeight: 44)
                Button("Paste") { if let s = UIPasteboard.general.string { webhookDraft = s } }.frame(minHeight: 44)
                if !draftTrimmed.isEmpty && !ChannelsSetupFormat.isCliqWebhook(draftTrimmed) {
                    Text(ChannelsSetupFormat.badWebhook).font(.footnote).foregroundStyle(Theme.muted)
                }
                Button("Save") { saveWebhook() }
                    .disabled(busy || !ChannelsSetupFormat.isCliqWebhook(draftTrimmed))
                    .frame(minHeight: 44)
                if changingWebhook {
                    Button("Cancel") { webhookDraft = ""; changingWebhook = false }.foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
            } else {
                HStack { Text("Webhook URL"); Spacer(); Text("Set").foregroundStyle(Theme.muted) }.frame(minHeight: 44)
                Button("Change") { changingWebhook = true }.frame(minHeight: 44)
            }
        } header: { Label("Cliq · Webhook", systemImage: "link") } footer: {
            Text("Send agent updates through your Cliq bot. \(ChannelsSetupFormat.restartNote)")
        }
    }

    private func saveWebhook() {
        let secret = draftTrimmed
        webhookDraft = ""
        changingWebhook = false
        run($note, busy: $busy, restarts: true) { await model.changeCliq(.webhook(secret)) }
    }

    private var ownerSection: some View {
        Section {
            TextField("Owner email", text: emailText, prompt: Text("you@company.com"))
                .keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                .frame(minHeight: 44)
            TextField("Owner ID", text: idText, prompt: Text("Cliq user ID"))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .frame(minHeight: 44)
            Button("Save") {
                let e = ChannelsSetupFormat.trimmed(emailText.wrappedValue), i = ChannelsSetupFormat.trimmed(idText.wrappedValue)
                email = nil; ownerId = nil
                run($note, busy: $busy, restarts: true) { await model.changeCliq(.owner(email: e.isEmpty ? nil : e, id: i.isEmpty ? nil : i)) }
            }
            .disabled(busy || !ownerDirty)
            .frame(minHeight: 44)
            if webhookSet {
                Button("Remove webhook", role: .destructive) { confirmRemove = true }
                    .disabled(busy)
                    .frame(minHeight: 44)
            }
        } header: { Text("Owner") } footer: { Text("Choose who receives your agent updates.") }
        .confirmationDialog(ChannelsSetupFormat.removeWebhookTitle, isPresented: $confirmRemove, titleVisibility: .visible) {
            Button(ChannelsSetupFormat.removeWebhookButton, role: .destructive) {
                run($note, busy: $busy, restarts: true) { await model.changeCliq(.removeWebhook) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { Text(ChannelsSetupFormat.removeWebhookMessage) }
    }

    private var repliesSection: some View {
        Section {
            Text(cliq.twoWay == true ? ChannelsSetupFormat.repliesOn : ChannelsSetupFormat.repliesOff)
                .font(.footnote).foregroundStyle(Theme.muted)
        } header: { Text("Replies") }
    }
}
#endif
