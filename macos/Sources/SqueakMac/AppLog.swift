import Foundation
import os
import SqueakMacCore

/// The app's one logger. Lines go to the unified log (private) and to an
/// in-memory ring buffer that "Copy diagnostics" reads. Log wording, never
/// message text, titles, paths or ids.
enum AppLog {
    static let buffer = LogBuffer(capacity: 200)
    private static let logger = Logger(subsystem: "com.squeak.mac", category: "app")

    static func info(_ line: String) {
        buffer.append(line)
        logger.info("\(line, privacy: .private)")
    }

    static func error(_ line: String) {
        buffer.append("ERROR " + line)
        logger.error("\(line, privacy: .private)")
    }
}
