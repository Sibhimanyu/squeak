import Foundation
import XCTest
import SqueakCore

/// The signed-out screen is one job. It has no scanner, no pasted link and no code; the only way to those is the single
/// small "Mac not on an account yet?" link at its foot, which hands over to the fallback screen.
final class SignInScreenSourceTests: XCTestCase {
    private func source(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/SqueakUI/\(name)")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func section(_ text: String, from start: String, to end: String) throws -> String {
        let a = try XCTUnwrap(text.range(of: start), start)
        let b = try XCTUnwrap(text.range(of: end, range: a.upperBound..<text.endIndex), end)
        return String(text[a.lowerBound..<b.lowerBound])
    }

    func testSignInViewHasNoScannerPasteOrCode() throws {
        let view = try section(try source("MacsView.swift"), from: "struct SignInView", to: "/// Signed in, no Mac open")
        for banned in ["QRScanner", "DataScanner", "Paste", "paste", "squeak://pair", "PairingScreen", "AwaitingApproval", "pairing code"] {
            XCTAssertFalse(view.contains(banned), "SignInView must not mention \(banned)")
        }
        // The one entry to the fallback is the link, built from the shared label.
        XCTAssertEqual(view.components(separatedBy: "onFallback()").count - 1, 1)
        XCTAssertTrue(view.contains("SignInScreen.fallbackLabel"))
    }

    func testTheMacListNeverShowsACodeOrAnApproveOnYourMacLine() throws {
        let macs = try source("MacsView.swift")
        let account = try source("AccountModel.swift")
        for text in [macs, account] {
            XCTAssertFalse(text.contains("pairingCode"))
            XCTAssertFalse(text.contains("If your Mac asks"))
            XCTAssertFalse(text.contains("Approve on"))
            XCTAssertFalse(text.contains("Link one in Squeak"))
        }
    }

    func testOnlyTheFallbackHostsTheScannerAndTheUnpairedScreenRoutesThereFromTheLink() throws {
        let unpaired = try section(try source("MacsView.swift"), from: "struct UnpairedView", to: "/// First run")
        XCTAssertTrue(unpaired.contains("PairView(onBack"))
        XCTAssertTrue(unpaired.contains("SignInView(onFallback"))
        let root = try source("SqueakRootView.swift")
        XCTAssertTrue(root.contains("UnpairedView()"))
        XCTAssertFalse(root.contains("case .unpaired: PairView"))
        XCTAssertEqual(SignInScreen.entries, [.signIn, .macNotOnAccount])
    }

    func testSettingsRemovesThisIPhoneFromAMacRatherThanUnpairing() throws {
        let settings = try source("SettingsView.swift")
        XCTAssertFalse(settings.contains("Unpair this iPhone"))
        XCTAssertTrue(settings.contains("Remove this iPhone from"))
    }
}
