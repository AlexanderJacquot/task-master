// swift-tools-version: 6.0
// The phone's logic without its views (ADR 022): screen models over the Rust core.
// Builds and tests on Linux against target/debug (scripts/ios/test-kit.sh); on Apple
// platforms the Rust library comes from the XCFramework built by
// scripts/ios/build-xcframework.sh.

import PackageDescription

#if os(Linux)
// The generated C header, and the Rust library from the workspace's target directory.
let ffi: [Target] = [
    .target(name: "taskmaster_mobileFFI", path: "Sources/taskmaster_mobileFFI")
]
let rustLibrary: [LinkerSetting] = [
    .unsafeFlags(["-L", "../../../target/debug"]),
    .linkedLibrary("taskmaster_mobile"),
]
#else
let ffi: [Target] = [
    .binaryTarget(name: "taskmaster_mobileFFI", path: "../build/TaskMasterMobile.xcframework")
]
let rustLibrary: [LinkerSetting] = []
#endif

let package = Package(
    name: "TaskMasterKit",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [
        .library(name: "TaskMasterKit", targets: ["TaskMasterKit"])
    ],
    targets: ffi + [
        // The Swift half of the UniFFI bindings: generated, never edited, not checked in.
        .target(
            name: "TaskMasterFFI",
            dependencies: ["taskmaster_mobileFFI"],
            path: "Sources/TaskMasterFFI",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: rustLibrary
        ),
        .target(
            name: "TaskMasterKit",
            dependencies: ["TaskMasterFFI"],
            path: "Sources/TaskMasterKit"
        ),
        .testTarget(
            name: "TaskMasterKitTests",
            dependencies: ["TaskMasterKit"],
            path: "Tests/TaskMasterKitTests"
        ),
    ]
)
