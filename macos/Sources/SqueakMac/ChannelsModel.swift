import AppKit
import Foundation
import Observation
import SqueakMacCore

/// Everything Settings › Channels and › iPhone read and do. Secrets live only in the daemon's `.env`
/// (written through `EnvFile`, 0600) and are never held after a save, shown, or logged: the log lines
/// here name actions, never values. In demo and capture runs nothing touches the real `.env` or daemon.
@MainActor @Observable
final class ChannelsModel {
    enum Keys {
        static let botToken = "SQUEAK_BOT_TOKEN"
        static let allowedChats = "SQUEAK_ALLOWED_CHAT_IDS"
        static let cliqWebhook = "SQUEAK_CLIQ_WEBHOOK_URL"
        static let cliqEmail = "SQUEAK_CLIQ_OWNER_EMAIL"
        static let cliqId = "SQUEAK_CLIQ_OWNER_ID"
    }

    static let relayCommand = "node ~/conductor/repos/squeak/dist/squeak/cli.js cliq-relay"

    @ObservationIgnored let client: DaemonClient
    @ObservationIgnored let env: EnvFile
    @ObservationIgnored let service: DaemonService
    let demo: Bool

    // What the daemon says. nil until the first answer.
    private(set) var channels: ChannelsStatus?
    /// The daemon answered 404: it predates the channels routes.
    private(set) var channelsOutdated = false
    private(set) var daemonReachable = true
    private(set) var remote: RemoteStatus?
    private(set) var remoteOutdated = false

    // What each channel may push (nil until the daemon answers), and why a change did not stick.
    private(set) var notify: NotifySettings?
    private(set) var notifyOutdated = false
    private(set) var notifyError: String?
    @ObservationIgnored private var notifyInFlight = 0

    // The bot picture row (Telegram) and the saved logo file (Cliq).
    private(set) var avatarState = BotAvatarState.idle
    private(set) var savedLogo: URL?
    private(set) var logoMessage: String?

    // What `.env` says (never the values of secrets).
    private(set) var tokenSet = false
    private(set) var webhookSet = false
    private(set) var savedAllowed: [Int] = []
    /// `.env` says the phone channel runs on Squeak's shared server.
    private(set) var phoneSharedInEnv = false

    // Telegram draft.
    var tokenDraft = ""
    var changingToken = false
    var allowed: [Int] = []
    private(set) var chatNames: [Int: String] = [:]
    private(set) var testResult: String?
    private(set) var testing = false

    // Cliq draft.
    var webhookDraft = ""
    var changingWebhook = false
    var ownerEmail = ""
    var ownerId = ""
    private var savedEmail = ""
    private var savedId = ""

    // Shared state.
    private(set) var restarting = false
    private(set) var notice: String?
    private(set) var pairingURL: String?
    private(set) var pairingError: String?
    private(set) var candidates: [TelegramCandidate] = []

    init(client: DaemonClient, demo: Bool, env: EnvFile = EnvFile(), service: DaemonService = DaemonService()) {
        self.client = client
        self.demo = demo
        self.env = env
        self.service = service
        if demo { seedDemo() } else { reloadEnv() }
    }

    // MARK: Derived

    var telegramDirty: Bool { !tokenDraft.trimmed.isEmpty || allowed != savedAllowed }
    var cliqDirty: Bool {
        !webhookDraft.trimmed.isEmpty || ownerEmail.trimmed != savedEmail || ownerId.trimmed != savedId
    }
    var tokenLooksValid: Bool { Self.isBotToken(tokenDraft.trimmed) }
    var webhookLooksValid: Bool { Self.isCliqWebhook(webhookDraft.trimmed) }

    static func isBotToken(_ s: String) -> Bool {
        let parts = s.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[0].allSatisfy(\.isNumber)
            && parts[1].count >= 20 && parts[1].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    static func isCliqWebhook(_ s: String) -> Bool {
        guard let u = URL(string: s), u.scheme == "https", let host = u.host?.lowercased() else { return false }
        return host == "zoho.com" || host.hasSuffix(".zoho.com") || host.contains(".zoho.") || host.hasPrefix("cliq.zoho.")
    }

    func name(for chat: Int) -> String? { chatNames[chat] }

    // MARK: Refresh

    func reloadEnv() {
        guard !demo else { return }
        let values = env.values()
        tokenSet = !(values[Keys.botToken] ?? "").trimmed.isEmpty
        webhookSet = !(values[Keys.cliqWebhook] ?? "").trimmed.isEmpty
        phoneSharedInEnv = !(values[FirebaseSetup.Keys.shared] ?? "").trimmed.isEmpty
        let ids = (values[Keys.allowedChats] ?? "").split(separator: ",").compactMap { Int(String($0).trimmed) }
        if !telegramDirty { savedAllowed = ids; allowed = ids }
        if !cliqDirty {
            savedEmail = (values[Keys.cliqEmail] ?? "").trimmed
            savedId = (values[Keys.cliqId] ?? "").trimmed
            ownerEmail = savedEmail
            ownerId = savedId
        }
    }

    func refresh() async {
        if demo { return }
        reloadEnv()
        do {
            channels = try await client.channels()
            channelsOutdated = channels == nil
            daemonReachable = true
        } catch {
            daemonReachable = false
        }
        await refreshNotify()
        await refreshVoice()
        await refreshGateway()
        await refreshRemote()
    }

    // Phone calls (nil until the daemon answers): who they ring, and why a change did not stick.
    private(set) var voice: VoiceSettings?
    private(set) var voiceOutdated = false
    private(set) var voiceError: String?
    private(set) var voiceSaving = false

    private var voiceRefreshGeneration = 0

    func refreshVoice(afterPinAction: Bool = false) async {
        if demo || voiceSaving || (pinBusy && !afterPinAction) { return }
        voiceRefreshGeneration += 1
        let generation = voiceRefreshGeneration
        do {
            let v = try await client.voiceSettings()
            guard generation == voiceRefreshGeneration else { return }
            voiceOutdated = v == nil
            if let v { voice = v }
        } catch {
            // The service is off or busy: keep what is shown.
        }
    }

    /// Saves the extension typed (empty clears it). Refused here if it is not 2 to 6 digits.
    func setVoiceCallee(_ typed: String) async {
        voiceError = nil
        let callee = VoiceSettings.normalized(typed)
        if let callee, !VoiceSettings.isExtension(callee) {
            voiceError = "An extension is 2 to 6 digits, like 101."
            return
        }
        if demo { voice?.callee = callee; return }
        voiceSaving = true
        do {
            if let answered = try await client.setVoiceCallee(callee) {
                voice = answered
            } else {
                voiceOutdated = true
                voiceError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            voiceError = "Could not save: Squeak on this Mac did not answer."
        }
        voiceSaving = false
    }

    private(set) var pauseBusy = false

    /// Turns the realistic call voice on or off, or picks its voice; takes the daemon's answer as the truth.
    func setNatural(enabled: Bool? = nil, voice: String? = nil) async {
        voiceError = nil
        if demo { return }
        pauseBusy = true
        defer { pauseBusy = false }
        do {
            if let answered = try await client.setNaturalVoice(enabled: enabled, voice: voice) {
                self.voice = answered
            } else {
                voiceError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            voiceError = "Could not save: Squeak on this Mac did not answer."
        }
        await refreshVoice()
    }

    /// Pauses or resumes calls and takes the daemon's answer as the truth.
    func setPause(_ choice: VoicePauseChoice) async {
        voiceError = nil
        if demo { return }
        pauseBusy = true
        defer { pauseBusy = false }
        do {
            if let answered = try await client.setVoicePause(choice) {
                voice = answered
            } else {
                voiceOutdated = true
                voiceError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            voiceError = "Could not save: Squeak on this Mac did not answer."
        }
        await refreshVoice()
    }

    /// Replaces the quick workspaces and takes the daemon's answer as the truth.
    func setFavorites(_ list: [FavoriteWorkspace]) async {
        voiceError = nil
        if demo { voice?.favorites = list; return }
        pauseBusy = true
        defer { pauseBusy = false }
        do {
            if let answered = try await client.setVoiceFavorites(list) {
                voice = answered
            } else {
                voiceOutdated = true
                voiceError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            voiceError = "Could not save: Squeak on this Mac did not answer."
        }
        await refreshVoice()
    }

    // The phone-call gateway (nil until the daemon answers; unavailable hides the section).
    private(set) var gateway: GatewayView?
    private(set) var gatewayAvailable = true
    private(set) var gatewayCode: GatewayPairResponse?
    private(set) var gatewayError: String?
    private(set) var gatewayBusy = false
    private var gatewayPoll: Task<Void, Never>?
    /// True from the moment you approve until the add-on reports in again (Squeak restarts to use the new pairing and
    /// the add-on takes a few seconds to say hello), so the page shows "Connecting…" instead of its old state.
    private(set) var gatewayConnecting = false
    private var gatewayConnectWatch: Task<Void, Never>?

    /// True from the press of "Update add-on" until the add-on reports the new version (or 3 min).
    private(set) var gatewayUpdating = false
    private var gatewayUpdateWatch: Task<Void, Never>?

    func updateGatewayAddon() async {
        guard !gatewayUpdating, !gatewayBusy, let target = gateway?.latestVersion, gateway?.updateAvailable == true else { return }
        gatewayError = nil
        if demo { return }
        gatewayBusy = true
        defer { gatewayBusy = false }
        do {
            switch try await client.updateGatewayAddon() {
            case .done: watchGatewayUpdate(to: target)
            case .refused(let sentence): gatewayError = sentence
            case .unavailable: gatewayError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            gatewayError = "Squeak on this Mac did not answer."
        }
    }

    private func watchGatewayUpdate(to target: String) {
        gatewayUpdateWatch?.cancel()
        gatewayUpdating = true
        gatewayUpdateWatch = Task { [weak self] in
            let deadline = Date().addingTimeInterval(180)
            var arrived = false
            while !Task.isCancelled, Date() < deadline {
                try? await Task.sleep(for: .seconds(3))
                guard let self else { return }
                await self.refreshGateway()
                if self.gateway?.status.version == target { arrived = true; break }
            }
            guard let self, !Task.isCancelled else { return }
            if !arrived { self.gatewayError = GatewayText.updateSlow }
            self.gatewayUpdating = false
        }
    }

    func refreshGateway() async {
        if demo { return }
        do {
            let v = try await client.gatewayView()
            gatewayAvailable = v != nil
            if let v { gateway = v }
        } catch {
            // Keep what is shown.
        }
    }

    // Call history and the gateway log: loaded when the sheet opens, refreshed every 10 s only while it is open.
    private(set) var calls: CallsView?
    private(set) var callsAvailable = true
    private var callsPoll: Task<Void, Never>?

    func refreshCalls() async {
        if demo { return }
        do {
            let v = try await client.voiceCalls()
            callsAvailable = v != nil
            if let v { calls = v }
        } catch {
            // Keep what is shown.
        }
    }

    func startCallsRefresh() {
        callsPoll?.cancel()
        callsPoll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshCalls()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    func stopCallsRefresh() { callsPoll?.cancel(); callsPoll = nil }

    /// Makes a new code and polls every 2 s until `endGatewayPairing()`.
    func startGatewayPairing() async {
        gatewayError = nil
        if demo { return }
        gatewayBusy = true
        defer { gatewayBusy = false }
        do {
            guard let r = try await client.startGatewayPairing() else {
                gatewayAvailable = false
                gatewayError = "Squeak on this Mac is older than this setting. Update it and try again."
                return
            }
            gatewayCode = r
            await refreshGateway()
            gatewayPoll?.cancel()
            gatewayPoll = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    if Task.isCancelled { break }
                    await self?.refreshGateway()
                }
            }
        } catch {
            gatewayError = "Squeak on this Mac did not answer, so no code was made."
        }
    }

    func approveGateway(_ approve: Bool) async {
        gatewayError = nil
        if demo { return }
        gatewayBusy = true
        defer { gatewayBusy = false }
        do {
            if try await client.approveGateway(approve) {
                if approve { watchGatewayConnecting() }
                await refreshGateway()
            } else {
                gatewayError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            gatewayError = "Squeak on this Mac did not answer."
        }
    }

    /// The typed-code flow. A found code moves the pairing view to a request; an old daemon sets `gatewayClaimUnavailable`.
    private(set) var gatewayClaimUnavailable = false

    func claimGateway(code: String) async {
        gatewayError = nil
        if demo { return }
        gatewayBusy = true
        defer { gatewayBusy = false }
        do {
            switch try await client.claimGateway(code: code) {
            case .found:
                await refreshGateway()
                gatewayPoll?.cancel()
                gatewayPoll = Task { [weak self] in
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(2))
                        if Task.isCancelled { break }
                        await self?.refreshGateway()
                    }
                }
            case .refused(let sentence): gatewayError = sentence
            case .unavailable: gatewayClaimUnavailable = true
            }
        } catch {
            gatewayError = "Squeak on this Mac did not answer."
        }
    }

    /// Polls until the add-on's first report after this approval (or 90 s). The daemon restarts in between, so a
    /// failed look is not an answer: the last view stays and the watch goes on.
    private func watchGatewayConnecting() {
        gatewayConnectWatch?.cancel()
        gatewayConnecting = true
        let approvedAt = Date().timeIntervalSince1970 * 1000
        gatewayConnectWatch = Task { [weak self] in
            let deadline = Date().addingTimeInterval(90)
            while !Task.isCancelled, Date() < deadline {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                await self.refreshGateway()
                if let s = self.gateway?.status, let at = s.at, at > approvedAt, s.state == .ok || s.state == .sipDown { break }
            }
            self?.gatewayConnecting = false
        }
    }

    func endGatewayPairing() {
        gatewayClaimUnavailable = false
        gatewayPoll?.cancel(); gatewayPoll = nil
        gatewayCode = nil; gatewayError = nil
        Task { await refreshGateway() }
    }

    // The call PIN: busy and error only; the PIN itself is never stored here.
    private(set) var pinBusy = false
    private(set) var pinError: String?
    private(set) var pinNotice: String?

    /// Runs one PIN action. Returns true when the daemon did it. Callers clear their fields afterwards.
    func runPin(_ action: PinAction, done: String) async -> Bool {
        guard !pinBusy else { return false }
        // An earlier poll must not replace a PIN action's authoritative response.
        voiceRefreshGeneration += 1
        pinError = nil; pinNotice = nil
        if demo { return false }
        pinBusy = true
        defer { pinBusy = false }
        do {
            switch try await client.pinAction(action) {
            case let .done(view):
                if let view { voice = view }
                pinNotice = done
                await refreshVoice(afterPinAction: true)
                return true
            case let .refused(reason): pinError = reason
            case .outdated: pinError = "Squeak on this Mac is older than this setting. Update it and try again."
            }
        } catch {
            pinError = "Squeak on this Mac did not answer."
        }
        return false
    }

    func changePin(current: String, new: String, repeated: String) async -> Bool {
        if let p = PinRules.problem(new: new, repeated: repeated) { pinError = p; pinNotice = nil; return false }
        guard PinRules.isValid(current) else { pinError = "Type your current PIN."; pinNotice = nil; return false }
        return await runPin(.change(current: current, next: new), done: "Your PIN is changed.")
    }

    func turnPinOff(current: String) async -> Bool {
        guard PinRules.isValid(current) else { pinError = "Type your current PIN."; pinNotice = nil; return false }
        return await runPin(.disable(current: current), done: "The PIN is off.")
    }

    func turnPinOn(new: String, repeated: String) async -> Bool {
        if let p = PinRules.problem(new: new, repeated: repeated) { pinError = p; pinNotice = nil; return false }
        return await runPin(.enable(next: new), done: "Your PIN is set.")
    }

    /// Only after the owner check passed (Touch ID or the Mac's login password).
    func resetPin(new: String?, repeated: String) async -> Bool {
        if let new, let p = PinRules.problem(new: new, repeated: repeated) { pinError = p; pinNotice = nil; return false }
        return await runPin(.reset(next: new), done: new == nil ? "The PIN is off." : "Your new PIN is set.")
    }

    /// Sends both settings; the shown state is whatever the daemon answers (`runPin` re-reads the view).
    func setPinPolicy(outgoing: PinPolicyChoice, incoming: PinPolicyChoice) async {
        _ = await runPin(.policy(outgoing: outgoing, incoming: incoming), done: "Saved.")
    }

    func clearPinMessages() { pinError = nil; pinNotice = nil }
    func reportPinError(_ text: String) { pinError = text; pinNotice = nil }

    func refreshNotify() async {
        if demo || notifyInFlight > 0 { return }
        do {
            let n = try await client.notifySettings()
            guard notifyInFlight == 0 else { return }
            notifyOutdated = n == nil
            if let n { notify = n }
        } catch {
            // The service is off or busy: keep what is shown, the status line already says so.
        }
    }

    /// One edit: shown at once, sent as one key, put back with a short reason if it fails, then re-read.
    func setNotify(_ channel: NotifyChannel, _ change: NotifyChange) async {
        notifyError = nil
        guard change.isValid else { notifyError = NotifyText.sameTimes; return }
        guard var settings = notify, let undo = settings.apply(change, to: channel) else { return }
        notify = settings
        if demo { return }
        notifyInFlight += 1
        var outcome: NotifyOutcome?
        do {
            outcome = try await client.changeNotify(channel, change)
        } catch {
            notifyError = NotifyText.failure(error)
        }
        notifyInFlight -= 1
        switch outcome {
        case .saved(let answered)?:
            if notifyInFlight == 0, let answered { notify = answered }
        case .outdated?:
            notifyOutdated = true
            notifyError = NotifyText.outdated
            notify?.rollback(undo, on: channel)
        case nil:
            notify?.rollback(undo, on: channel)
        }
        await refreshNotify()
    }

    func refreshRemote() async {
        if demo { return }
        do {
            let r = try await client.remoteStatus()
            remote = r
            remoteOutdated = r == nil && daemonReachable && channels == nil
        } catch {
            if !(error is CancellationError) { remote = nil }
        }
    }

    /// Whether the phone channel exists on the daemon: its own report, else the channels summary.
    var phoneEnabled: Bool { remote?.available ?? channels?.phone.enabled ?? false }

    // MARK: Telegram

    func pasteToken() {
        if let s = NSPasteboard.general.string(forType: .string) { tokenDraft = s.trimmed }
    }

    func link(_ chat: TelegramCandidate) {
        if !allowed.contains(chat.id) { allowed.append(chat.id) }
        if !chat.name.isEmpty { chatNames[chat.id] = chat.name }
        candidates.removeAll { $0.id == chat.id }
    }

    func unlink(_ id: Int) { allowed.removeAll { $0 == id } }

    func pollCandidates() async {
        while !Task.isCancelled {
            if demo {
                candidates = Self.demoCandidates.filter { !allowed.contains($0.id) }
            } else if let list = try? await client.telegramCandidates() {
                candidates = list.filter { !allowed.contains($0.id) }
                for c in list where !c.name.isEmpty { chatNames[c.id] = c.name }
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    func saveTelegram() async {
        let token = tokenDraft.trimmed
        if demo { tokenSet = tokenSet || !token.isEmpty; savedAllowed = allowed; tokenDraft = ""; changingToken = false; return }
        var change: [String: String?] = [Keys.allowedChats: allowed.isEmpty ? nil : allowed.map(String.init).joined(separator: ",")]
        if !token.isEmpty { change[Keys.botToken] = token }
        guard write(change) else { return }
        tokenDraft = ""
        changingToken = false
        AppLog.info("telegram settings saved")
        await restartAndRefresh()
    }

    func turnOffTelegram() async {
        if demo { tokenSet = false; return }
        guard write([Keys.botToken: nil]) else { return }
        tokenDraft = ""
        changingToken = false
        AppLog.info("telegram turned off")
        await restartAndRefresh()
    }

    func sendTest() async {
        testing = true
        defer { testing = false }
        if demo { testResult = "Sent to \(max(allowed.count, 1)) chat."; return }
        do {
            guard let r = try await client.telegramTest() else {
                testResult = "Update the Squeak service to send a test message."
                return
            }
            if r.ok {
                testResult = "Sent to \(r.sentTo) chat\(r.sentTo == 1 ? "" : "s")."
            } else {
                testResult = r.reason.map { "Not sent: \($0)" } ?? "Not sent."
            }
        } catch {
            testResult = "Not sent: \(Self.describe(error))"
        }
    }

    // MARK: Bot picture

    static let botLogoFile = "squeak-bot-avatar-640.jpg"

    /// Telegram's "Use Squeak logo": the daemon uploads the brand's own JPG.
    func setTelegramAvatar() async {
        guard avatarState.canSet(telegramConfigured: tokenSet) else { return }
        avatarState = .working
        if demo { try? await Task.sleep(for: .milliseconds(400)); avatarState = .done; return }
        avatarState = BotAvatarState(await client.setTelegramAvatar())
    }

    /// Cliq's "Save logo…": the same JPG, written where the person chooses. The API route is blocked by the org.
    func saveBotLogo(to url: URL) {
        guard let source = BrandAssets.url(Self.botLogoFile), let data = try? Data(contentsOf: source) else {
            logoMessage = "The logo file is missing from this copy of Squeak."
            return
        }
        do {
            try data.write(to: url, options: .atomic)
            savedLogo = url
            logoMessage = "Saved."
        } catch {
            logoMessage = "Couldn't save the logo there."
        }
    }

    // MARK: Cliq

    func pasteWebhook() {
        if let s = NSPasteboard.general.string(forType: .string) { webhookDraft = s.trimmed }
    }

    func saveCliq() async {
        let hook = webhookDraft.trimmed
        if demo { webhookSet = webhookSet || !hook.isEmpty; webhookDraft = ""; changingWebhook = false; savedEmail = ownerEmail; savedId = ownerId; return }
        var change: [String: String?] = [
            Keys.cliqEmail: ownerEmail.trimmed.isEmpty ? nil : ownerEmail.trimmed,
            Keys.cliqId: ownerId.trimmed.isEmpty ? nil : ownerId.trimmed,
        ]
        if !hook.isEmpty { change[Keys.cliqWebhook] = hook }
        guard write(change) else { return }
        webhookDraft = ""
        changingWebhook = false
        AppLog.info("cliq settings saved")
        await restartAndRefresh()
    }

    func removeWebhook() async {
        if demo { webhookSet = false; return }
        guard write([Keys.cliqWebhook: nil]) else { return }
        webhookDraft = ""
        changingWebhook = false
        AppLog.info("cliq webhook removed")
        await restartAndRefresh()
    }

    // MARK: iPhone

    var onSharedServer: Bool { remote?.shared ?? phoneSharedInEnv }

    /// Turns the iPhone channel on with these keys and restarts the daemon; the caller opens pairing.
    @discardableResult func enablePhone(_ change: [String: String?]) async -> Bool {
        if demo { return true }
        guard write(change) else { return false }
        AppLog.info("iphone channel saved")
        await restartAndRefresh()
        return true
    }

    func startPairing() async {
        pairingError = nil
        pairingURL = nil
        if demo { pairingURL = "squeak://pair?d=demo-not-a-real-code"; return }
        do {
            if let p = try await client.remotePair() {
                pairingURL = p.url
                AppLog.info("pairing window opened")
            } else {
                pairingError = "This Squeak service can't pair phones. Update it, then try again."
            }
        } catch {
            pairingError = "Couldn't start pairing: \(Self.describe(error))"
        }
        await refreshRemote()
    }

    /// Puts the pairing code (exactly the QR's text) on the clipboard, for Squeak for Web.
    @discardableResult func copyPairingCode() -> Bool {
        guard let url = pairingURL, !url.isEmpty else { return false }
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(url, forType: .string)
    }

    func endPairing() { pairingURL = nil; pairingError = nil }

    func pollRemote() async {
        while !Task.isCancelled {
            await refreshRemote()
            try? await Task.sleep(for: .seconds(2))
        }
    }

    func approve(_ id: String) async { await decide(id, approve: true) }
    func reject(_ id: String) async { await decide(id, approve: false) }

    private func decide(_ id: String, approve: Bool) async {
        if demo {
            guard let p = remote?.pending.first(where: { $0.id == id }) else { return }
            var r = remote ?? RemoteStatus()
            r.pending.removeAll { $0.id == id }
            if approve { r.devices.append(.init(id: p.id, name: p.name, pairedAt: Date())) }
            remote = r
            return
        }
        do {
            _ = approve ? try await client.remoteApprove(deviceId: id) : try await client.remoteReject(deviceId: id)
            AppLog.info(approve ? "phone approved" : "phone rejected")
        } catch { notice = "Couldn't answer the phone: \(Self.describe(error))" }
        await refreshRemote()
    }

    func revoke(_ id: String) async {
        if demo { remote?.devices.removeAll { $0.id == id }; return }
        do { _ = try await client.remoteRevoke(deviceId: id); AppLog.info("phone revoked") } catch { notice = "Couldn't revoke: \(Self.describe(error))" }
        await refreshRemote()
    }

    func resetPhones() async {
        if demo { remote?.devices = []; return }
        do { _ = try await client.remoteReset(); AppLog.info("phone channel reset") } catch { notice = "Couldn't reset: \(Self.describe(error))" }
        await refreshRemote()
    }

    // MARK: Summary rows for Connections

    struct SummaryRow: Identifiable {
        enum Dot { case none, working, error }
        let id: String
        let name: String
        let value: String
        let dot: Dot
    }

    var summary: [SummaryRow] {
        guard daemonReachable, !channelsOutdated, let c = channels else {
            let word = daemonReachable ? (channelsOutdated ? "update the Squeak service" : "checking") : "service is off"
            return ["Telegram", "Zoho Cliq", "iPhone"].map { SummaryRow(id: $0, name: $0, value: word, dot: .none) }
        }
        let tg: SummaryRow
        if !c.telegram.configured {
            tg = .init(id: "tg", name: "Telegram", value: "not set up", dot: .none)
        } else if c.telegram.polling == .error {
            tg = .init(id: "tg", name: "Telegram", value: "error", dot: .error)
        } else if c.telegram.polling == .ok {
            tg = .init(id: "tg", name: "Telegram", value: c.telegram.botUsername.map { "connected as @\($0)" } ?? "connected", dot: .working)
        } else {
            tg = .init(id: "tg", name: "Telegram", value: "off", dot: .none)
        }
        let cliq = SummaryRow(id: "cliq", name: "Zoho Cliq", value: c.cliq.twoWay ? "two-way" : c.cliq.oneWay ? "one-way" : "not set up", dot: .none)
        let n = remote?.activeDevices.count ?? 0
        let ph = SummaryRow(
            id: "phone", name: "iPhone",
            value: !phoneEnabled ? "off" : n == 0 ? "not paired" : n == 1 ? "1 iPhone paired" : "\(n) iPhones paired", dot: .none)
        return [tg, cliq, ph]
    }

    // MARK: Plumbing

    private func write(_ change: [String: String?]) -> Bool {
        do {
            try env.apply(change)
            reloadEnv()
            return true
        } catch {
            notice = "Couldn't save to Squeak's settings file."
            AppLog.error("env write failed")
            return false
        }
    }

    private func restartAndRefresh() async {
        restarting = true
        notice = nil
        defer { restarting = false }
        do {
            try await service.restart()
        } catch {
            notice = "Saved, but the Squeak service didn't restart. Run “launchctl kickstart -k gui/$(id -u)/com.squeak.daemon” in Terminal."
            await refresh()
            return
        }
        // The daemon takes a moment to bind its port and read the new settings.
        for _ in 0..<8 {
            try? await Task.sleep(for: .seconds(1))
            await refresh()
            if daemonReachable, channels != nil { break }
        }
    }

    static func describe(_ error: Error) -> String {
        switch error as? AdapterError {
        case .daemonDown: "the Squeak service isn't running"
        case .tokenMissing, .tokenRejected: "Squeak's access token wasn't accepted"
        case .timedOut: "it took too long"
        default: "unexpected answer"
        }
    }

    // MARK: Demo

    static let demoCandidates = [
        TelegramCandidate(id: 5_550_103, name: "Priya Raman", type: "private", at: Date().addingTimeInterval(-40)),
        TelegramCandidate(id: -1_001_234_567, name: "Build watch", type: "group", at: Date().addingTimeInterval(-600)),
    ]

    private func seedDemo() {
        if ProcessInfo.processInfo.environment["SQUEAK_MAC_DEMO_AVATAR"] == "done" {
            avatarState = .done
            savedLogo = URL(fileURLWithPath: "/Users/demo/Desktop/squeak-bot-avatar.jpg")
            logoMessage = "Saved."
        }
        tokenSet = true
        webhookSet = true
        savedAllowed = [5_550_101]
        allowed = savedAllowed
        chatNames = [5_550_101: "Sibhi"]
        ownerEmail = "owner@example.com"; savedEmail = ownerEmail
        ownerId = "20087654321"; savedId = ownerId
        channels = ChannelsStatus(
            telegram: .init(configured: true, polling: .ok, botUsername: "squeak_demo_bot", allowedChatIds: [5_550_101]),
            cliq: .init(oneWay: true, twoWay: false), phone: .init(enabled: true))
        var cliqNotify = ChannelNotify()
        cliqNotify.quiet = NotifyQuiet.standard
        cliqNotify.finished = .all
        notify = NotifySettings(telegram: ChannelNotify(), cliq: cliqNotify, telegramSetUp: true, cliqSetUp: true)
        voice = VoiceSettings(mode: "gateway", callee: "101")
        remote = RemoteStatus(
            available: true, configured: true, phoneOpen: true, pairingOpen: true,
            devices: [.init(id: "d1", name: "Sibhi's iPhone", pairedAt: Date().addingTimeInterval(-86400 * 12))],
            pending: [.init(id: "d2", name: "iPhone 17", code: "4821", requestedAt: Date().addingTimeInterval(-20))])
        // SQUEAK_MAC_DEMO_STATE lets a capture show the other states.
        switch ProcessInfo.processInfo.environment["SQUEAK_MAC_DEMO_STATE"] {
        case "empty":
            tokenSet = false; webhookSet = false; savedAllowed = []; allowed = []; chatNames = [:]
            ownerEmail = ""; ownerId = ""; savedEmail = ""; savedId = ""
            channels = ChannelsStatus()
            notify = NotifySettings()
            remote = RemoteStatus(available: false)
        case "open":
            savedAllowed = []; allowed = []
            channels = ChannelsStatus(telegram: .init(configured: true, polling: .ok, botUsername: "squeak_demo_bot", open: true))
        case "error":
            channels = ChannelsStatus(telegram: .init(configured: true, polling: .error, lastError: "Telegram rejected the token (401).", botUsername: nil, allowedChatIds: [5_550_101]))
        default: break
        }
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
