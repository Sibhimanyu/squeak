import Foundation

// Sets up the iPhone channel's Firebase for the person, through the Firebase CLI and Google's REST
// endpoints. Everything that touches the machine or the network is injected, so tests run every step
// against fakes. Tokens are never logged or put in an error message.

// MARK: Seams

public struct CommandResult: Sendable, Equatable {
    public var status: Int32
    public var output: String
    public init(status: Int32, output: String) { self.status = status; self.output = output }
}

public protocol CommandRunning: Sendable {
    /// Runs a program with stdout and stderr merged. `declineYesNo` writes "n" whenever the output
    /// asks "(Y/n)", which is how the CLI's optional questions are skipped.
    func run(_ executable: String, _ arguments: [String], directory: URL?, declineYesNo: Bool, timeout: TimeInterval) async -> CommandResult
}

public struct SetupRequest: Sendable, Equatable {
    public var method: String
    public var url: String
    public var bearer: String?
    public var body: String?
    public init(method: String, url: String, bearer: String? = nil, body: String? = nil) {
        self.method = method; self.url = url; self.bearer = bearer; self.body = body
    }
}

public struct SetupReply: Sendable, Equatable {
    public var status: Int
    public var body: String
    public init(status: Int, body: String = "") { self.status = status; self.body = body }
}

public protocol HTTPSending: Sendable {
    func send(_ request: SetupRequest) async throws -> SetupReply
}

public protocol FileDownloading: Sendable {
    func download(from url: URL, to file: URL, progress: @Sendable @escaping (Double) -> Void) async throws
}

// MARK: Model

public enum FirebaseStep: Int, CaseIterable, Sendable {
    case tool, signIn, project, database, rules, check

    public var title: String {
        switch self {
        case .tool: "Get the Firebase tool"
        case .signIn: "Sign in to Google"
        case .project: "Create your project"
        case .database: "Create the database"
        case .rules: "Lock it down"
        case .check: "Check it works"
        }
    }
}

public struct FirebaseProjectInfo: Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct StepFailure: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case generic
        /// The Google account never accepted Firebase's terms.
        case terms
        /// The account cannot make another project; these are the ones it has.
        case quota([FirebaseProjectInfo])
        /// The tool cannot run here at all: only the by-hand route is left.
        case needsHandSetup
        /// Google already has a project with the chosen name; the person picks another.
        case nameTaken
    }
    public var kind: Kind
    public var message: String
    public init(_ kind: Kind, _ message: String) { self.kind = kind; self.message = message }
}

public enum StepState: Sendable, Equatable {
    case pending
    case running(Double?)
    case done
    case failed(StepFailure)
}

public struct FirebaseSetupResult: Sendable, Equatable {
    public var projectId: String
    public var databaseURL: String
}

public enum FirebaseSetup {
    public static let consoleURL = "https://console.firebase.google.com/"
    public static let databasePageURL = "https://console.firebase.google.com/project/_/database"
    public static let cliDownload = URL(string: "https://firebase.tools/bin/macos/latest")!

    public static let sharedProject = "squeak-shared"
    public static let sharedDatabase = "https://squeak-shared-default-rtdb.firebaseio.com"

    public enum Keys {
        public static let project = "SQUEAK_REMOTE_PROJECT"
        public static let database = "SQUEAK_REMOTE_DATABASE_URL"
        public static let shared = "SQUEAK_REMOTE_SHARED"
    }

    public static func ownChanges(projectId: String, databaseURL: String) -> [String: String?] {
        [Keys.project: projectId, Keys.database: databaseURL, Keys.shared: nil]
    }

    public static let sharedChanges: [String: String?] = [
        Keys.project: sharedProject, Keys.database: sharedDatabase, Keys.shared: "1",
    ]

    /// Only Firebase's own database hosts, over https.
    public static func isValidDatabaseURL(_ s: String) -> Bool {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)), u.scheme == "https",
              u.user == nil, u.port == nil, let host = u.host?.lowercased() else { return false }
        let ok = host.hasSuffix(".firebasedatabase.app") || host.hasSuffix(".firebaseio.com")
        return ok && host.split(separator: ".").count >= 3 && (u.path.isEmpty || u.path == "/")
    }

    public static func normalizedDatabaseURL(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix("/") { t.removeLast() }
        return t
    }

    /// The project id a database URL names: `<id>-default-rtdb.…` or `<id>.…`.
    public static func projectId(fromDatabaseURL s: String) -> String? {
        guard let host = URL(string: s)?.host, let first = host.split(separator: ".").first else { return nil }
        let label = String(first)
        return label.hasSuffix("-default-rtdb") ? String(label.dropLast("-default-rtdb".count)) : label
    }

    /// A plain starting name: "squeak-" and the Mac's short user name, made safe for a project id.
    public static func suggestedProjectName(userName: String) -> String {
        var out = ""
        for ch in userName.lowercased() {
            let ok = ch.isASCII && (ch.isLetter || ch.isNumber)
            let c: Character = ok ? ch : "-"
            if c == "-", out.last == "-" { continue }
            out.append(c)
        }
        var name = String(("squeak-" + out).prefix(30))
        while name.hasSuffix("-") { name.removeLast() }
        return name
    }

    /// Google's project id rule. Nil when fine, else one plain sentence saying what to change.
    public static func projectNameProblem(_ name: String) -> String? {
        if name.count < 6 { return "Use at least 6 characters." }
        if name.count > 30 { return "Use at most 30 characters." }
        if !name.allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") }) {
            return "Use only lowercase letters, digits and hyphens."
        }
        if !(name.first?.isASCII == true && name.first?.isLetter == true) { return "Start with a letter." }
        if name.hasSuffix("-") { return "Don't end with a hyphen." }
        return nil
    }

    public static func randomChannelId(randomIndex: () -> Int = { Int.random(in: 0..<62) }) -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
        return String((0..<24).map { _ in alphabet[randomIndex() % alphabet.count] })
    }

    // MARK: Parsing

    static func stripANSI(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[A-Za-z]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\r", with: "")
    }

    /// Emails `firebase login:list` names ("Logged in as x" / "Signed in as x").
    public static func accounts(fromLoginList output: String) -> [String] {
        let text = stripANSI(output)
        guard let re = try? NSRegularExpression(pattern: #"(?:Logged|Signed) in as\s+([^\s]+@[^\s]+)"#, options: .caseInsensitive) else { return [] }
        let ns = text as NSString
        var out: [String] = []
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let e = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: CharacterSet(charactersIn: ".,;()"))
            if !out.contains(e) { out.append(e) }
        }
        return out
    }

    /// The JSON object in CLI output that may carry banners before it.
    static func jsonObject(in output: String) -> [String: Any]? {
        let text = stripANSI(output)
        guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start < end,
              let data = String(text[start...end]).data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    public static func projects(fromListJSON output: String) -> [FirebaseProjectInfo] {
        guard let result = jsonObject(in: output)?["result"] as? [[String: Any]] else { return [] }
        return result.compactMap { p in
            guard let id = p["projectId"] as? String else { return nil }
            return FirebaseProjectInfo(id: id, name: (p["displayName"] as? String) ?? id)
        }
    }
}

// MARK: Runner

public actor FirebaseSetupRunner {
    public struct Config: Sendable {
        public var home: URL
        public var supportDirectory: URL
        public var configDirectory: URL
        public var fileExists: @Sendable (String) -> Bool
        public var sleep: @Sendable (TimeInterval) async -> Void
        public var now: @Sendable () -> Date
        public var randomIndex: @Sendable () -> Int
        public var databaseWait: TimeInterval
        public var databaseRetryEvery: TimeInterval

        public init(
            home: URL = URL.homeDirectory,
            supportDirectory: URL = URL.homeDirectory.appending(path: "Library/Application Support/squeak"),
            configDirectory: URL? = nil,
            fileExists: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
            sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) },
            now: @escaping @Sendable () -> Date = Date.init,
            randomIndex: @escaping @Sendable () -> Int = { Int.random(in: 0..<62) },
            databaseWait: TimeInterval = 240,
            databaseRetryEvery: TimeInterval = 15
        ) {
            self.home = home
            self.supportDirectory = supportDirectory
            if let configDirectory {
                self.configDirectory = configDirectory
            } else if let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], !xdg.isEmpty {
                self.configDirectory = URL(fileURLWithPath: xdg)
            } else {
                self.configDirectory = home.appending(path: ".config")
            }
            self.fileExists = fileExists
            self.sleep = sleep
            self.now = now
            self.randomIndex = randomIndex
            self.databaseWait = databaseWait
            self.databaseRetryEvery = databaseRetryEvery
        }
    }

    public typealias Update = @Sendable (FirebaseStep, StepState) -> Void

    private let commands: CommandRunning
    private let http: HTTPSending
    private let downloader: FileDownloading
    private let config: Config

    private var cli: String?
    private var account: String?
    private var projectId: String?
    private var projectName: String?
    private var databaseURL: String?
    private var signedInChecked = false

    public init(commands: CommandRunning, http: HTTPSending, downloader: FileDownloading, config: Config = Config(), projectName: String? = nil) {
        self.projectName = projectName
        self.commands = commands; self.http = http; self.downloader = downloader; self.config = config
    }

    public var chosenAccount: String? { account }
    public var currentProject: String? { projectId }

    // MARK: Pieces the sheet calls between steps

    /// Accounts the tool is already signed in to (needs the tool).
    public func signedInAccounts() async -> [String] {
        guard let cli = await locateCLI() else { return [] }
        let r = await commands.run(cli, ["login:list"], directory: nil, declineYesNo: true, timeout: 30)
        return FirebaseSetup.accounts(fromLoginList: r.output)
    }

    public func useAccount(_ email: String?) { account = email }

    /// "Use another account": adds one, and returns the one that was added.
    public func addAccount() async -> String? {
        guard let cli = await locateCLI() else { return nil }
        let before = await signedInAccounts()
        _ = await commands.run("/usr/bin/script", ["-q", "/dev/null", cli, "login:add"], directory: nil, declineYesNo: true, timeout: 300)
        let after = await signedInAccounts()
        let added = after.first { !before.contains($0) } ?? after.last
        if let added { account = added }
        return added
    }

    public func useName(_ name: String) { projectName = name }

    public func useProject(_ id: String) { projectId = id; databaseURL = nil }

    // MARK: Run

    /// Runs steps in order from `start`, stopping at the first failure. Returns the result only when every step passed.
    public func run(from start: FirebaseStep = .tool, update: @escaping Update) async -> FirebaseSetupResult? {
        for step in FirebaseStep.allCases where step.rawValue >= start.rawValue {
            update(step, .running(nil))
            let failure: StepFailure?
            switch step {
            case .tool: failure = await ensureTool(update)
            case .signIn: failure = await signIn()
            case .project: failure = await createProject()
            case .database: failure = await createDatabase()
            case .rules: failure = await deployRules()
            case .check: failure = await verify()
            }
            if let failure { update(step, .failed(failure)); return nil }
            update(step, .done)
        }
        guard let projectId, let databaseURL else { return nil }
        return FirebaseSetupResult(projectId: projectId, databaseURL: databaseURL)
    }

    // MARK: a. the tool

    var downloadedPath: String { config.supportDirectory.appending(path: "bin/firebase").path }

    func locateCLI() async -> String? {
        if let cli { return cli }
        let h = config.home.path
        let candidates = ["/usr/local/bin/firebase", "/opt/homebrew/bin/firebase", "\(h)/.npm-global/bin/firebase", downloadedPath]
        if let hit = candidates.first(where: config.fileExists) { cli = hit; return hit }
        let r = await commands.run("/bin/zsh", ["-lc", "command -v firebase"], directory: nil, declineYesNo: false, timeout: 15)
        if r.status == 0, let line = FirebaseSetup.stripANSI(r.output).split(separator: "\n").last(where: { $0.hasPrefix("/") }),
           config.fileExists(String(line)) {
            cli = String(line)
            return cli
        }
        return nil
    }

    private func ensureTool(_ update: @escaping Update) async -> StepFailure? {
        if await locateCLI() != nil { return nil }
        let rosetta = await commands.run("/usr/bin/arch", ["-x86_64", "/usr/bin/true"], directory: nil, declineYesNo: false, timeout: 15)
        guard rosetta.status == 0 else {
            return StepFailure(.needsHandSetup, "This Mac can't run Google's Firebase tool without Rosetta.")
        }
        let target = URL(fileURLWithPath: downloadedPath)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try await downloader.download(from: FirebaseSetup.cliDownload, to: target) { update(.tool, .running($0)) }
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        } catch {
            return StepFailure(.generic, "Couldn't download the Firebase tool. Check your connection and try again.")
        }
        cli = target.path
        return nil
    }

    // MARK: b. sign in

    private var accountArgs: [String] { account.map { ["--account", $0] } ?? [] }

    private func signIn() async -> StepFailure? {
        guard let cli = await locateCLI() else { return StepFailure(.generic, "The Firebase tool is missing.") }
        var accounts = await signedInAccounts()
        if accounts.isEmpty {
            _ = await commands.run("/usr/bin/script", ["-q", "/dev/null", cli, "login"], directory: nil, declineYesNo: true, timeout: 300)
            accounts = await signedInAccounts()
        }
        guard !accounts.isEmpty else {
            return StepFailure(.generic, "Sign-in didn't finish. Finish it in your browser, then try again.")
        }
        if account == nil || !accounts.contains(account!) { account = accounts[0] }
        return nil
    }

    // MARK: c. project

    private func createProject() async -> StepFailure? {
        if projectId != nil { return nil }
        guard let cli = await locateCLI() else { return StepFailure(.generic, "The Firebase tool is missing.") }
        guard let id = projectName, FirebaseSetup.projectNameProblem(id) == nil else {
            return StepFailure(.nameTaken, "Pick a name for your project.")
        }
        let r = await commands.run(cli, ["projects:create", id, "--display-name", "Squeak", "--non-interactive"] + accountArgs,
                                   directory: nil, declineYesNo: true, timeout: 180)
        if r.status == 0 { projectId = id; return nil }
        let text = FirebaseSetup.stripANSI(r.output).lowercased()
        if text.contains("already exists") || text.contains("already_exists") || text.contains("is not available") {
            return StepFailure(.nameTaken, "That name is taken across Google. Try another.")
        }
        if text.contains("terms of service") || text.contains("accept the") && text.contains("terms") {
            return StepFailure(.terms, "Google needs you to accept Firebase's terms first. Open the Firebase console, accept them, then try again.")
        }
        if text.contains("quota") || text.contains("limit") || text.contains("too many projects") {
            let list = await commands.run(cli, ["projects:list", "--json"] + accountArgs, directory: nil, declineYesNo: true, timeout: 60)
            return StepFailure(.quota(FirebaseSetup.projects(fromListJSON: list.output)),
                               "This Google account can't make another project. Pick one it already has.")
        }
        return StepFailure(.generic, "Couldn't create the project.")
    }

    // MARK: d. database

    /// Refreshes the token by running a cheap CLI call, then reads it from the CLI's own store.
    func accessToken() async -> String? {
        guard let cli = await locateCLI() else { return nil }
        _ = await commands.run(cli, ["projects:list", "--json"] + accountArgs, directory: nil, declineYesNo: true, timeout: 60)
        let file = config.configDirectory.appending(path: "configstore/firebase-tools.json")
        guard let data = try? Data(contentsOf: file), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        func token(_ dict: [String: Any]?) -> String? { (dict?["tokens"] as? [String: Any])?["access_token"] as? String }
        if let account, (root["user"] as? [String: Any])?["email"] as? String != account {
            let extra = root["additionalAccounts"] as? [[String: Any]]
            return token(extra?.first { ($0["user"] as? [String: Any])?["email"] as? String == account })
        }
        return token(root)
    }

    private func createDatabase() async -> StepFailure? {
        guard let id = projectId else { return StepFailure(.generic, "No project yet.") }
        if databaseURL != nil { return nil }
        guard let token = await accessToken() else {
            return StepFailure(.generic, "Couldn't read your Firebase sign-in. Sign in again and retry.")
        }
        let started = config.now()
        while true {
            do {
                let enable = try await http.send(SetupRequest(
                    method: "POST", url: "https://serviceusage.googleapis.com/v1/projects/\(id)/services/firebasedatabase.googleapis.com:enable",
                    bearer: token, body: "{}"))
                var outcome = enable.status
                var reply = enable
                if (200..<300).contains(enable.status) || enable.status == 409 {
                    reply = try await http.send(SetupRequest(
                        method: "POST",
                        url: "https://firebasedatabase.googleapis.com/v1beta/projects/\(id)/locations/us-central1/instances?databaseId=\(id)-default-rtdb",
                        bearer: token, body: #"{"type":"DEFAULT_DATABASE"}"#))
                    outcome = reply.status
                }
                if (200..<300).contains(outcome) {
                    databaseURL = Self.databaseURL(in: reply.body) ?? "https://\(id)-default-rtdb.firebaseio.com"
                    return nil
                }
                if outcome == 409 {
                    if let url = try await existingDatabase(project: id, token: token) { databaseURL = url; return nil }
                    return StepFailure(.generic, "This project already has a database Squeak can't use.")
                }
                if outcome != 403 && outcome != 429 && outcome < 500 {
                    return StepFailure(.generic, "Google refused to create the database (\(outcome)).")
                }
            } catch {
                // A dropped connection is retried like a not-yet-ready project.
            }
            if config.now().timeIntervalSince(started) + config.databaseRetryEvery > config.databaseWait {
                return StepFailure(.generic, "The project isn't ready yet. Give it a minute and try again.")
            }
            await config.sleep(config.databaseRetryEvery)
        }
    }

    private func existingDatabase(project id: String, token: String) async throws -> String? {
        let r = try await http.send(SetupRequest(
            method: "GET", url: "https://firebasedatabase.googleapis.com/v1beta/projects/\(id)/locations/-/instances", bearer: token))
        guard (200..<300).contains(r.status), let data = r.body.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = root["instances"] as? [[String: Any]] else { return nil }
        return list.first { $0["type"] as? String == "DEFAULT_DATABASE" }.flatMap { $0["databaseUrl"] as? String }
    }

    static func databaseURL(in body: String) -> String? {
        guard let data = body.data(using: .utf8), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = root["databaseUrl"] as? String, FirebaseSetup.isValidDatabaseURL(url) else { return nil }
        return FirebaseSetup.normalizedDatabaseURL(url)
    }

    // MARK: e. rules

    private func deployRules() async -> StepFailure? {
        guard let cli = await locateCLI(), let id = projectId else { return StepFailure(.generic, "Nothing to deploy to yet.") }
        let dir = FileManager.default.temporaryDirectory.appending(path: "squeak-firebase-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try Data(FirebaseRules.fileContents.utf8).write(to: dir.appending(path: "database.rules.json"))
            try Data(#"{"database":{"rules":"database.rules.json"}}"#.utf8).write(to: dir.appending(path: "firebase.json"))
        } catch {
            return StepFailure(.generic, "Couldn't prepare the database rules.")
        }
        let r = await commands.run(cli, ["deploy", "--only", "database", "--project", id, "--non-interactive"] + accountArgs,
                                   directory: dir, declineYesNo: true, timeout: 180)
        return r.status == 0 ? nil : StepFailure(.generic, "Couldn't lock the database down.")
    }

    // MARK: f. verify

    private func verify() async -> StepFailure? {
        guard let url = databaseURL else { return StepFailure(.generic, "No database yet.") }
        return await Self.check(url: url, http: http, randomIndex: config.randomIndex, now: config.now)
    }

    /// The same check for the by-hand route: a sealed-looking write works, a malformed one and a read of the root are refused.
    public static func check(url: String, http: HTTPSending, randomIndex: @escaping @Sendable () -> Int = { Int.random(in: 0..<62) },
                             now: @Sendable () -> Date = Date.init) async -> StepFailure? {
        let base = FirebaseSetup.normalizedDatabaseURL(url)
        let doc = "\(base)/channels/\(FirebaseSetup.randomChannelId(randomIndex: randomIndex))/state/check.json"
        do {
            let ms = Int(now().timeIntervalSince1970 * 1000)
            let put = try await http.send(SetupRequest(method: "PUT", url: doc, body: #"{"box":"squeak-setup-check","at":\#(ms)}"#))
            guard put.status == 200 else {
                return StepFailure(.generic, "Squeak can't write to this database. Check the rules were published.")
            }
            let bad = try await http.send(SetupRequest(method: "PUT", url: doc, body: #"{"x":1}"#))
            let root = try await http.send(SetupRequest(method: "GET", url: base + "/.json"))
            _ = try? await http.send(SetupRequest(method: "DELETE", url: doc))
            if (200..<300).contains(bad.status) || (200..<300).contains(root.status) {
                return StepFailure(.generic, "This database is open to anyone. Publish Squeak's rules and check again.")
            }
            return nil
        } catch {
            return StepFailure(.generic, "Couldn't reach the database. Check your connection.")
        }
    }
}
