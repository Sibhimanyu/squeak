// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SqueakMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SqueakMacCore", targets: ["SqueakMacCore"]),
        .executable(name: "SqueakMac", targets: ["SqueakMac"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .target(name: "SqueakMacCore"),
        .executableTarget(
            name: "SqueakMac",
            dependencies: [
                "SqueakMacCore",
                .product(name: "Sparkle", package: "Sparkle"),
            ]),
        .testTarget(
            name: "SqueakMacCoreTests", dependencies: ["SqueakMacCore"],
            resources: [.copy("Fixtures/relay-vectors.json")]),
    ],
    swiftLanguageModes: [.v6]
)
