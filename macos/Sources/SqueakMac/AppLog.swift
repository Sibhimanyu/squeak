import Foundation
import os
import SqueakMacCore

/// The app's one logger. Lines go to the unified log (private) and to an
/// in-memory ring buffer that "Copy diagnostics" reads. Log wording, never
/// message text, titles, paths or ids.
enum AppLog {
    static let buffer = LogBuffer(capacity: 200)
    private static let logger = Logger(subsystem: "com.squeak.mac", category: "app")

    private static let echo = ProcessInfo.processInfo.environment["SQUEAK_MAC_DEBUG"] == "1"

    static func info(_ line: String) {
        buffer.append(line)
        if echo { FileHandle.standardError.write(Data("[squeak] \(line)\n".utf8)) }
        logger.info("\(line, privacy: .private)")
    }

    /// A timing or counter line, never message content: public in the unified log so `log show` can read it.
    static func timing(_ line: String) {
        buffer.append(line)
        logger.info("\(line, privacy: .public)")
    }

    static func error(_ line: String) {
        buffer.append("ERROR " + line)
        logger.error("\(line, privacy: .private)")
    }
}
