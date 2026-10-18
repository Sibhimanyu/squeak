// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SqueakMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SqueakMacCore", targets: ["SqueakMacCore"]),
        .executable(name: "SqueakMac", targets: ["SqueakMac"]),
    ],
    targets: [
        .target(name: "SqueakMacCore"),
        .executableTarget(name: "SqueakMac", dependencies: ["SqueakMacCore"]),
        .testTarget(
            name: "SqueakMacCoreTests", dependencies: ["SqueakMacCore"],
            resources: [.copy("Fixtures/relay-vectors.json")]),
    ],
    swiftLanguageModes: [.v6]
)
