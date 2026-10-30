import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct AppInstallTests {
    @Test func jsonShape() throws {
        let d = try AppInstall.json(
            appPath: "/Applications/Squeak.app", bundleId: "com.squeak.mac", version: "2.12.14",
            writtenAt: Date(timeIntervalSince1970: 1.5))
        let o = try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
        #expect(o["v"] as? Int == 1)
        #expect(o["appPath"] as? String == "/Applications/Squeak.app")
        #expect(o["bundleId"] as? String == "com.squeak.mac")
        #expect(o["version"] as? String == "2.12.14")
        #expect(o["writtenAt"] as? Int == 1500)
    }

    @Test func writesAtomicallyWith0600AndOverwrites() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "appinstall-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        try AppInstall.write(appPath: "/A.app", bundleId: "com.squeak.mac", version: "1", supportDir: dir)
        try AppInstall.write(appPath: "/B.app", bundleId: "com.squeak.mac", version: "2", supportDir: dir)
        let file = dir.appending(path: "app-install.json")
        let o = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        #expect(o["appPath"] as? String == "/B.app")
        let perms = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        #expect(perms == 0o600)
        #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).count == 1)
    }

    @Test func buildFoldersAreRecognised() {
        #expect(AppInstall.isBuildFolder("/x/macos/build/Squeak.app"))
        #expect(AppInstall.isBuildFolder("/x/macos/.build/debug/Squeak.app"))
        #expect(!AppInstall.isBuildFolder("/Applications/Squeak.app"))
    }
}
