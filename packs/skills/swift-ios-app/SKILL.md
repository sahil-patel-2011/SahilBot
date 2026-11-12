---
name: swift-ios-app
description: Build or change an iOS/macOS app in Swift (SwiftUI) with Xcode tools.
source: you
uses: 0
category: Coding
---

1. Check Xcode and simulators (xcodebuild -version, xcrun simctl list).
2. Use SwiftUI with small views and an observable model.
3. Build from the command line (xcodebuild -scheme NAME -destination 'platform=iOS Simulator,name=iPhone 16' build) and fix errors.
4. Run in the simulator and check screens (xcrun simctl io booted screenshot).
5. Report how to run it; signing and App Store steps need the user's account.
