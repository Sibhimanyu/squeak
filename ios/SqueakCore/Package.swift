// swift-tools-version:5.9
import PackageDescription

// Everything in the iPhone app that is not UI: the pairing payload, the
// channel crypto, the Firestore client and the command format. Kept apart so
// `swift test` runs it on the Mac.
let package = Package(
    name: "SqueakCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SqueakCore", targets: ["SqueakCore"]),
        // The iPhone screens: the whole UI of the Squeak app (see SqueakRootView).
        .library(name: "SqueakUI", targets: ["SqueakUI"]),
    ],
    dependencies: [
        .package(path: "../../icons"),
        .package(path: "../../markup"),
    ],
    targets: [
        .target(name: "SqueakCore"),
        .target(name: "SqueakUI", dependencies: ["SqueakCore", .product(name: "SqueakIcons", package: "icons"), .product(name: "SqueakMarkup", package: "markup")], resources: [.process("Resources")]),
        // Writes the fixtures the Mac's tests verify against (src/remote/fixtures).
        .executableTarget(name: "squeak-fixtures", dependencies: ["SqueakCore"]),
        // A phone in a terminal: pairs and replies over real Firestore (scripts/e2e-remote.sh).
        .executableTarget(name: "squeak-e2e", dependencies: ["SqueakCore"]),
        .testTarget(name: "SqueakUITests", dependencies: ["SqueakUI", "SqueakCore"]),
        .testTarget(name: "SqueakCoreTests", dependencies: ["SqueakCore"], resources: [.copy("Fixtures")]),
    ]
)
