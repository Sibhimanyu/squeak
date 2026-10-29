import AppKit
import Foundation
import Observation
import SqueakMacCore

/// Drives the "Set up the iPhone channel" sheet. The steps live in `FirebaseSetupRunner`; this holds what
/// the sheet shows. Nothing here logs a token, a password or a database URL.
@MainActor @Observable
final class FirebaseSetupModel {
    enum Screen { case choose, own, manual, shared }

    var screen = Screen.choose
    private(set) var states: [FirebaseStep: StepState] = [:]
    private(set) var running = false
    private(set) var finished = false
    private(set) var accounts: [String] = []
    private(set) var checkedAccounts = false
    var account: String?
    private(set) var addingAccount = false
    private(set) var saveError: String?
    var projectName = FirebaseSetup.suggestedProjectName(userName: NSUserName())

    // By hand.
    var urlDraft = ""
    private(set) var verifying = false
    private(set) var verified = false
    private(set) var manualError: String?
    private(set) var copiedRules = false

    @ObservationIgnored let channels: ChannelsModel
    @ObservationIgnored private let runner: FirebaseSetupRunner
    @ObservationIgnored private let http: HTTPSending

    init(channels: ChannelsModel) {
        self.channels = channels
        let http = URLSessionHTTP()
        self.http = http
        runner = FirebaseSetupRunner(commands: ProcessCommandRunner(), http: http, downloader: URLSessionDownloader())
    }

    var failedStep: (FirebaseStep, StepFailure)? {
        for s in FirebaseStep.allCases { if case .failed(let f)? = states[s] { return (s, f) } }
        return nil
    }

    var nameProblem: String? { FirebaseSetup.projectNameProblem(projectName) }

    func state(_ s: FirebaseStep) -> StepState { states[s] ?? .pending }

    // MARK: One-click

    func beginOwn() {
        screen = .own
        states = [:]
        Task { await checkAccounts() }
    }

    /// Looks for a signed-in Google account before anything starts, so the person can choose.
    private func checkAccounts() async {
        checkedAccounts = false
        accounts = await runner.signedInAccounts()
        if account == nil || !accounts.contains(account!) { account = accounts.first }
        await runner.useAccount(account)
        checkedAccounts = true
    }

    func useAnotherAccount() {
        addingAccount = true
        Task {
            if let added = await runner.addAccount() { account = added }
            accounts = await runner.signedInAccounts()
            addingAccount = false
        }
    }

    func chooseAccount(_ email: String) {
        account = email
        Task { await runner.useAccount(email) }
    }

    func start(from step: FirebaseStep = .tool) {
        guard !running else { return }
        running = true
        saveError = nil
        for s in FirebaseStep.allCases where s.rawValue >= step.rawValue { states[s] = .pending }
        Task {
            await runner.useAccount(account)
            await runner.useName(projectName)
            let result = await runner.run(from: step) { s, st in Task { @MainActor [weak self] in self?.states[s] = st } }
            // The updates hop to the main actor one by one; let the last one land before reading them.
            await Task.yield()
            running = false
            if let result { await save(FirebaseSetup.ownChanges(projectId: result.projectId, databaseURL: result.databaseURL)) }
        }
    }

    func retry() { if let (step, _) = failedStep { start(from: step) } }

    func pickExisting(_ project: FirebaseProjectInfo) {
        Task {
            await runner.useProject(project.id)
            start(from: .database)
        }
    }

    func openConsole() { Self.open(FirebaseSetup.consoleURL) }
    static func open(_ s: String) { if let u = URL(string: s) { NSWorkspace.shared.open(u) } }

    // MARK: By hand

    var urlLooksValid: Bool { FirebaseSetup.isValidDatabaseURL(urlDraft) }

    func copyRules() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(FirebaseRulesText.value, forType: .string)
        copiedRules = true
        Task { try? await Task.sleep(for: .seconds(2)); copiedRules = false }
    }

    func resetVerification() { verified = false; manualError = nil }

    func verifyManual() {
        guard urlLooksValid, !verifying else { return }
        verifying = true
        manualError = nil
        verified = false
        let url = FirebaseSetup.normalizedDatabaseURL(urlDraft)
        Task {
            let failure = await FirebaseSetupRunner.check(url: url, http: http)
            verifying = false
            if let failure { manualError = failure.message; return }
            verified = true
        }
    }

    func saveManual() {
        let url = FirebaseSetup.normalizedDatabaseURL(urlDraft)
        guard verified, let id = FirebaseSetup.projectId(fromDatabaseURL: url) else { return }
        Task { await save(FirebaseSetup.ownChanges(projectId: id, databaseURL: url)) }
    }

    // MARK: Shared

    func useShared() { Task { await save(FirebaseSetup.sharedChanges) } }

    private func save(_ change: [String: String?]) async {
        if await channels.enablePhone(change) { finished = true } else { saveError = "Couldn't save to Squeak's settings file." }
    }
}
