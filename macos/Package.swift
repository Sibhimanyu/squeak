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
        .package(url: "https://github.com/Sibhimanyu/heresay-swift", from: "0.2.0"),
        .package(path: "../icons"),
    ],
    targets: [
        .target(name: "SqueakMacCore"),
        .executableTarget(
            name: "SqueakMac",
            dependencies: [
                "SqueakMacCore",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "Heresay", package: "heresay-swift"),
                .product(name: "SqueakIcons", package: "icons"),
            ]),
        .testTarget(
            name: "SqueakMacCoreTests", dependencies: ["SqueakMacCore"],
            resources: [.copy("Fixtures/relay-vectors.json")]),
    ],
    swiftLanguageModes: [.v6]
)
