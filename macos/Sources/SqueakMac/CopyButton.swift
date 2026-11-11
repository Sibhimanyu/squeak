import AppKit
import SqueakMacCore
import SwiftUI

/// A visible one-tap Copy: anything the owner has to type somewhere else carries one.
struct CopyButton: View {
    let text: String
    @State private var copied = false
    var body: some View {
        Button(copied ? "Copied" : "Copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        }
        .buttonStyle(SecondaryButtonStyle())
        .accessibilityLabel("Copy \(text)")
    }
}
