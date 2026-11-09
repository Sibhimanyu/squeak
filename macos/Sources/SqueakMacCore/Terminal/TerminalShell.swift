import Foundation

/// How a terminal's shell is started, and when closing its tab needs a question.
public enum TerminalShell {
    public struct Launch: Equatable, Sendable {
        public var executable: String
        public var args: [String]
        /// `KEY=VALUE` lines, the form `LocalProcess` takes.
        public var environment: [String]
        public var name: String { (executable as NSString).lastPathComponent }
    }

    /// The person's login shell: `$SHELL` when it is an executable file, else `/bin/zsh`, run as `-l`, with
    /// `TERM=xterm-256color` whatever the app was started with.
    public static func launch(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
    ) -> Launch {
        var shell = "/bin/zsh"
        if let s = environment["SHELL"], s.hasPrefix("/"), isExecutable(s) { shell = s }
        var env = environment
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "Squeak"
        if env["LANG"] == nil, env["LC_ALL"] == nil { env["LANG"] = "en_US.UTF-8" }
        return Launch(executable: shell, args: ["-l"], environment: env.map { "\($0.key)=\($0.value)" }.sorted())
    }

    public enum CloseDecision: Equatable, Sendable {
        case closeNow
        /// A foreground process other than the shell is running; ask first.
        case confirm
    }

    /// `shellPid` is the shell's process id (it leads its own group), `foregroundGroup` the pty's foreground
    /// process group (`tcgetpgrp`), or nil/≤0 when it cannot be read (the shell has already gone: nothing to ask).
    public static func closeDecision(shellPid: Int32, foregroundGroup: Int32?) -> CloseDecision {
        guard let fg = foregroundGroup, fg > 0, shellPid > 0 else { return .closeNow }
        return fg == shellPid ? .closeNow : .confirm
    }
}
