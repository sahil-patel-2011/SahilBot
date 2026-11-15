---
name: swift-ios-app
description: Build, test or fix Swift and SwiftUI apps for iOS and macOS - xcodebuild or SwiftPM, state wrappers, MainActor concurrency, signing and sandbox.
source: you
uses: 0
category: Coding
triggers: swiftui, xcodebuild, package.swift, swift build, swift test, xctest, swift testing, @observable, @mainactor, sendable warning, xcode scheme, ios simulator, macos app sandbox, entitlements, codesign, swiftlint
---

## When
Any Swift code, Xcode project or Swift package. Signing, provisioning, notarization and App Store steps need the user's Apple account; prepare them, don't perform them.

## Orient
1. Project type: .xcworkspace (use it if present, e.g. CocoaPods) > .xcodeproj > Package.swift alone.
2. xcodebuild -version; xcodebuild -list (schemes, targets); xcrun simctl list devices available (exact simulator names).
3. Read the deployment target: @Observable and Swift Testing need iOS 17 / macOS 14 and Xcode 16.

## Commands (run_command; long, so pass a timeout)
- Build: xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' build. macOS: -destination 'platform=macOS'.
- Test: same with test; one test: -only-testing:AppTests/CartTests/testTotal. Add -quiet, or pipe to xcbeautify if installed.
- SwiftPM: swift build, swift test, swift test --filter CartTests/testTotal. code(action="run_tests") handles swift packages.
- Lint/format: swiftlint lint --strict; swift format lint -r Sources (toolchain 6+) or swiftformat --lint.
- Simulator: xcrun simctl boot, install, launch; xcrun simctl io booted screenshot shot.png.

## State
- @State: value owned by this view (private). @Binding: child edits a parent's value.
- iOS 17+: @Observable final class Model; owner holds @State var model = Model(); children take it as a plain property, @Bindable when they need $bindings; @Environment(Model.self) for app-wide.
- Older targets: ObservableObject + @Published, @StateObject where created, @ObservedObject where passed in. Never create an object inside @ObservedObject; it is rebuilt every render.
- Keep views small; logic in the model so it is testable without UI.

## Concurrency
- UI types and view models are @MainActor. Start async work with .task { } (cancels when the view disappears) or .task(id:) to restart on change.
- await suspends; state can change across it, so re-check after awaiting. Use actors for shared mutable state, not locks plus DispatchQueue.
- Swift 6 Sendable errors: make the type a struct of Sendable values, an actor, or @MainActor. @unchecked Sendable is a last resort with a comment.
- Task.detached and DispatchQueue.main.async in new code are smells.

## Optionals and memory
- guard let / if let x, ?? for defaults. No force unwrap or try! outside tests; try? silently drops errors.
- Escaping closures stored by self (timers, notifications, Combine sinks, completion handlers) need [weak self] then guard let self. Delegates are weak var. Long-running Task loops in a class should capture weak self.

## macOS specifics
- App Sandbox needs explicit entitlements: com.apple.security.network.client, files.user-selected.read-write, etc. A silent failure to read a file or open a socket is usually a missing entitlement.
- Hardened runtime plus notarization for distribution. Inspect: codesign -dv --entitlements - App.app; codesign --verify --deep --strict -vv App.app; spctl -a -vv App.app.

## Pitfalls
- Hand-editing project.pbxproj; minimal targeted edits only, or ask the user to add files in Xcode (folder-synced groups in Xcode 16 avoid this).
- Stale builds: pass -derivedDataPath build and clean that, not the user's global DerivedData.
- Simulator name not installed; pick one from simctl list.
- Heavy work in body or init of a View; body runs often.

## Verify
Zero errors and no new warnings from xcodebuild or swift build, the targeted test then the scheme's tests, and a simulator screenshot for UI changes.

## Example
```swift
@Observable @MainActor final class FeedModel {
  var items: [Item] = []
  func load() async { items = (try? await api.items()) ?? [] }
}
struct FeedView: View {
  @State private var model = FeedModel()
  var body: some View { List(model.items) { Text($0.title) }.task { await model.load() } }
}
```
