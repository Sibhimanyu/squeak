import Foundation
import Testing
@testable import SqueakMacCore

private final class FakeCommands: CommandRunning, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls: [[String]] = []
    let handler: @Sendable (String, [String]) -> CommandResult
    init(_ handler: @escaping @Sendable (String, [String]) -> CommandResult) { self.handler = handler }
    func run(_ executable: String, _ arguments: [String], directory: URL?, declineYesNo: Bool, timeout: TimeInterval) async -> CommandResult {
        lock.withLock { calls.append([executable] + arguments) }
        return handler(executable, arguments)
    }
    func called(_ needle: String) -> Bool { lock.lock(); defer { lock.unlock() }; return calls.contains { $0.contains(needle) } }
}

private final class FakeHTTP: HTTPSending, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var requests: [SetupRequest] = []
    private var createAttempts = 0
    var createFailures = 0
    var createStatusAfter = 200
    var openDatabase = false
    func send(_ r: SetupRequest) async throws -> SetupReply {
        lock.withLock { requests.append(r) }
        if r.url.contains("serviceusage") { return SetupReply(status: 200) }
        if r.url.contains("/locations/us-central1/instances") {
            let n = lock.withLock { createAttempts += 1; return createAttempts }
            if n <= createFailures { return SetupReply(status: 403, body: "PERMISSION_DENIED") }
            if createStatusAfter == 409 { return SetupReply(status: 409) }
            return SetupReply(status: 200, body: #"{"databaseUrl":"https://p-default-rtdb.firebaseio.com"}"#)
        }
        if r.url.contains("/locations/-/instances") {
            return SetupReply(status: 200, body: #"{"instances":[{"type":"USER_DATABASE","databaseUrl":"https://x.firebaseio.com"},{"type":"DEFAULT_DATABASE","databaseUrl":"https://old-default-rtdb.firebaseio.com"}]}"#)
        }
        if r.url.hasSuffix(".json") {
            if r.method == "PUT", r.body?.contains("squeak-setup-check") == true { return SetupReply(status: 200) }
            if r.method == "DELETE" { return SetupReply(status: 200) }
            return SetupReply(status: openDatabase ? 200 : 401)
        }
        return SetupReply(status: 404)
    }
}

private struct NoDownload: FileDownloading {
    func download(from url: URL, to file: URL, progress: @Sendable @escaping (Double) -> Void) async throws {
        try Data("bin".utf8).write(to: file)
        progress(1)
    }
}

private final class States: @unchecked Sendable {
    private let lock = NSLock()
    private var map: [FirebaseStep: StepState] = [:]
    func set(_ s: FirebaseStep, _ v: StepState) { lock.lock(); map[s] = v; lock.unlock() }
    subscript(s: FirebaseStep) -> StepState? { lock.lock(); defer { lock.unlock() }; return map[s] }
}

private func tempHome(token: String = "tok-1") throws -> URL {
    let home = FileManager.default.temporaryDirectory.appending(path: "squeak-fb-\(UUID().uuidString)")
    let store = home.appending(path: ".config/configstore")
    try FileManager.default.createDirectory(at: store, withIntermediateDirectories: true)
    try Data(#"{"user":{"email":"a@x.com"},"tokens":{"access_token":"\#(token)"},"additionalAccounts":[{"user":{"email":"b@x.com"},"tokens":{"access_token":"tok-b"}}]}"#.utf8)
        .write(to: store.appending(path: "firebase-tools.json"))
    return home
}

private func config(_ home: URL, cliPresent: Bool = true) -> FirebaseSetupRunner.Config {
    FirebaseSetupRunner.Config(
        home: home, supportDirectory: home.appending(path: "support"), configDirectory: home.appending(path: ".config"),
        fileExists: { cliPresent && $0 == "/opt/homebrew/bin/firebase" }, sleep: { _ in }, now: { Date(timeIntervalSince1970: 1_000) },
        randomIndex: { 3 })
}

private let signedIn = "Logged in as a@x.com\n"

@Suite struct FirebaseSetupTests {
    @Test func rulesMatchTheRepoFile() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appending(path: "firebase/database.rules.json")
        let file = try String(contentsOf: repo, encoding: .utf8)
        #expect(FirebaseRules.fileContents == file)
    }

    @Test func parsing() {
        #expect(FirebaseSetup.accounts(fromLoginList: "Logged in as a@x.com\nSigned in as b@y.org") == ["a@x.com", "b@y.org"])
        #expect(FirebaseSetup.isValidDatabaseURL("https://p-default-rtdb.firebaseio.com"))
        #expect(FirebaseSetup.isValidDatabaseURL("https://p-default-rtdb.europe-west1.firebasedatabase.app/"))
        #expect(!FirebaseSetup.isValidDatabaseURL("http://p.firebaseio.com"))
        #expect(!FirebaseSetup.isValidDatabaseURL("https://evil.com"))
        #expect(!FirebaseSetup.isValidDatabaseURL("https://firebaseio.com.evil.com"))
        #expect(FirebaseSetup.projectId(fromDatabaseURL: "https://abc-default-rtdb.firebaseio.com") == "abc")
        #expect(FirebaseSetup.randomChannelId().count == 24)
        let changes = FirebaseSetup.ownChanges(projectId: "p", databaseURL: "u")
        #expect(changes["SQUEAK_REMOTE_SHARED"] == .some(nil))
        #expect(FirebaseSetup.sharedChanges["SQUEAK_REMOTE_SHARED"] == "1")
    }

    @Test func suggestsAPlainName() {
        #expect(FirebaseSetup.suggestedProjectName(userName: "Sibhi") == "squeak-sibhi")
        #expect(FirebaseSetup.suggestedProjectName(userName: "Jo.Ann  Lee_9") == "squeak-jo-ann-lee-9")
        #expect(FirebaseSetup.suggestedProjectName(userName: "a-very-long-user-name-indeed-yes").count <= 30)
        #expect(!FirebaseSetup.suggestedProjectName(userName: "abcdefghijklmnopqrstuvw-xyz").hasSuffix("-"))
        #expect(FirebaseSetup.suggestedProjectName(userName: "") == "squeak")
        #expect(FirebaseSetup.projectNameProblem(FirebaseSetup.suggestedProjectName(userName: "Sibhi")) == nil)
    }

    @Test func validatesProjectNames() {
        #expect(FirebaseSetup.projectNameProblem("squeak-abc") == nil)
        #expect(FirebaseSetup.projectNameProblem("abc12") != nil)
        #expect(FirebaseSetup.projectNameProblem(String(repeating: "a", count: 31)) != nil)
        #expect(FirebaseSetup.projectNameProblem(String(repeating: "a", count: 30)) == nil)
        #expect(FirebaseSetup.projectNameProblem("Squeak-abc") != nil)
        #expect(FirebaseSetup.projectNameProblem("squeak_abc") != nil)
        #expect(FirebaseSetup.projectNameProblem("1squeak") != nil)
        #expect(FirebaseSetup.projectNameProblem("squeak-") != nil)
    }

    @Test func takenNameAsksForAnotherAndNeverAppends() async throws {
        let home = try tempHome()
        let taken = Locked(true)
        let cmds = FakeCommands { _, args in
            if args.first == "login:list" { return CommandResult(status: 0, output: signedIn) }
            if args.first == "projects:create" {
                return taken.get ? CommandResult(status: 1, output: "Error: Request failed: project ALREADY_EXISTS") : CommandResult(status: 0, output: "")
            }
            return CommandResult(status: 0, output: "")
        }
        let runner = FirebaseSetupRunner(commands: cmds, http: FakeHTTP(), downloader: NoDownload(), config: config(home), projectName: "squeak-sibhi")
        let states = States()
        #expect(await runner.run { states.set($0, $1) } == nil)
        guard case .failed(let f)? = states[.project] else { Issue.record("no failure"); return }
        #expect(f.kind == .nameTaken)
        #expect(f.message == "That name is taken across Google. Try another.")
        #expect(cmds.calls.filter { $0.contains("projects:create") }.allSatisfy { $0.contains("squeak-sibhi") })
        taken.set(false)
        await runner.useName("squeak-sibhi-mac")
        let result = await runner.run(from: .project) { states.set($0, $1) }
        #expect(result?.projectId == "squeak-sibhi-mac")
        #expect(cmds.calls.contains { $0.contains("projects:create") && $0.contains("squeak-sibhi-mac") })
    }

    @Test func happyPathWithDatabaseRetries() async throws {
        let home = try tempHome()
        let cmds = FakeCommands { _, args in
            if args.first == "login:list" { return CommandResult(status: 0, output: signedIn) }
            return CommandResult(status: 0, output: "")
        }
        let http = FakeHTTP(); http.createFailures = 3
        let runner = FirebaseSetupRunner(commands: cmds, http: http, downloader: NoDownload(), config: config(home), projectName: "squeak-test")
        let states = States()
        let result = await runner.run { states.set($0, $1) }
        #expect(result == FirebaseSetupResult(projectId: "squeak-test", databaseURL: "https://p-default-rtdb.firebaseio.com"))
        for s in FirebaseStep.allCases { #expect(states[s] == .done) }
        #expect(http.requests.filter { $0.url.contains("/us-central1/instances") }.count == 4)
        #expect(http.requests.first { $0.url.contains("serviceusage") }?.bearer == "tok-1")
        #expect(cmds.called("deploy"))
        #expect(http.requests.last?.method == "DELETE")
    }

    @Test func addedAccountPassesAccountFlagAndItsToken() async throws {
        let home = try tempHome()
        let cmds = FakeCommands { _, args in
            args.first == "login:list" ? CommandResult(status: 0, output: "Logged in as a@x.com\nLogged in as b@x.com") : CommandResult(status: 0, output: "")
        }
        let http = FakeHTTP()
        let runner = FirebaseSetupRunner(commands: cmds, http: http, downloader: NoDownload(), config: config(home), projectName: "squeak-test")
        await runner.useAccount("b@x.com")
        _ = await runner.run { _, _ in }
        #expect(cmds.calls.contains { $0.contains("projects:create") && $0.contains("--account") && $0.contains("b@x.com") })
        #expect(http.requests.first { $0.url.contains("serviceusage") }?.bearer == "tok-b")
    }

    @Test func termsFailureThenRetry() async throws {
        let home = try tempHome()
        let cmds = FakeCommands { _, args in
            if args.first == "login:list" { return CommandResult(status: 0, output: signedIn) }
            if args.first == "projects:create" { return CommandResult(status: 1, output: "Error: You must accept the Terms of Service") }
            return CommandResult(status: 0, output: "")
        }
        let runner = FirebaseSetupRunner(commands: cmds, http: FakeHTTP(), downloader: NoDownload(), config: config(home), projectName: "squeak-test")
        let states = States()
        #expect(await runner.run { states.set($0, $1) } == nil)
        guard case .failed(let f)? = states[.project] else { Issue.record("no failure"); return }
        #expect(f.kind == .terms)
        #expect(states[.database] == nil)
    }

    @Test func quotaOffersExistingProjectsThenContinues() async throws {
        let home = try tempHome()
        let cmds = FakeCommands { _, args in
            if args.first == "login:list" { return CommandResult(status: 0, output: signedIn) }
            if args.first == "projects:create" { return CommandResult(status: 1, output: "Error: quota exceeded for projects") }
            if args.first == "projects:list" { return CommandResult(status: 0, output: #"{"status":"success","result":[{"projectId":"old","displayName":"Old"}]}"#) }
            return CommandResult(status: 0, output: "")
        }
        let http = FakeHTTP(); http.createStatusAfter = 409
        let runner = FirebaseSetupRunner(commands: cmds, http: http, downloader: NoDownload(), config: config(home), projectName: "squeak-test")
        let states = States()
        #expect(await runner.run { states.set($0, $1) } == nil)
        guard case .failed(let f)? = states[.project] else { Issue.record("no failure"); return }
        #expect(f.kind == .quota([FirebaseProjectInfo(id: "old", name: "Old")]))
        await runner.useProject("old")
        let result = await runner.run(from: .database) { states.set($0, $1) }
        #expect(result == FirebaseSetupResult(projectId: "old", databaseURL: "https://old-default-rtdb.firebaseio.com"))
    }

    @Test func missingToolWithoutRosettaNeedsHandSetup() async throws {
        let home = try tempHome()
        let cmds = FakeCommands { exe, _ in CommandResult(status: exe == "/usr/bin/arch" ? 1 : 1, output: "") }
        let runner = FirebaseSetupRunner(commands: cmds, http: FakeHTTP(), downloader: NoDownload(), config: config(home, cliPresent: false), projectName: "squeak-test")
        let states = States()
        #expect(await runner.run { states.set($0, $1) } == nil)
        guard case .failed(let f)? = states[.tool] else { Issue.record("no failure"); return }
        #expect(f.kind == .needsHandSetup)
    }

    @Test func missingToolIsDownloadedWithRosetta() async throws {
        let home = try tempHome()
        let cmds = FakeCommands { exe, args in
            if exe == "/usr/bin/arch" { return CommandResult(status: 0, output: "") }
            if args.first == "login:list" { return CommandResult(status: 0, output: signedIn) }
            return CommandResult(status: exe == "/bin/zsh" ? 1 : 0, output: "")
        }
        let runner = FirebaseSetupRunner(commands: cmds, http: FakeHTTP(), downloader: NoDownload(), config: config(home, cliPresent: false), projectName: "squeak-test")
        let states = States()
        _ = await runner.run { states.set($0, $1) }
        #expect(states[.tool] == .done)
        let path = home.appending(path: "support/bin/firebase").path
        let perms = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
        #expect(perms == 0o755)
        #expect(cmds.calls.contains { $0.first == path })
    }

    @Test func signInRunsLoginThroughScriptWhenNobodyIsSignedIn() async throws {
        let home = try tempHome()
        let loggedIn = Locked(false)
        let cmds = FakeCommands { exe, args in
            if exe == "/usr/bin/script" { loggedIn.set(true); return CommandResult(status: 0, output: "") }
            if args.first == "login:list" { return CommandResult(status: 0, output: loggedIn.get ? signedIn : "No authorized accounts") }
            return CommandResult(status: 0, output: "")
        }
        let runner = FirebaseSetupRunner(commands: cmds, http: FakeHTTP(), downloader: NoDownload(), config: config(home), projectName: "squeak-test")
        let result = await runner.run { _, _ in }
        #expect(result != nil)
        #expect(cmds.calls.contains { $0.starts(with: ["/usr/bin/script", "-q", "/dev/null"]) && $0.last == "login" })
    }

    @Test func verifyRefusesAnOpenDatabase() async {
        let http = FakeHTTP(); http.openDatabase = true
        let failure = await FirebaseSetupRunner.check(url: "https://p-default-rtdb.firebaseio.com", http: http)
        #expect(failure != nil)
        let good = await FirebaseSetupRunner.check(url: "https://p-default-rtdb.firebaseio.com/", http: FakeHTTP())
        #expect(good == nil)
    }
}

private final class Locked: @unchecked Sendable {
    private let lock = NSLock(); private var v: Bool
    init(_ v: Bool) { self.v = v }
    func set(_ n: Bool) { lock.lock(); v = n; lock.unlock() }
    var get: Bool { lock.lock(); defer { lock.unlock() }; return v }
}
