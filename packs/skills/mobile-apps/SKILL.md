---
name: mobile-apps
description: Builds SwiftUI or React Native/Expo apps - navigation, state, persistence, offline, permissions, lifecycle, simulator testing and TestFlight.
source: you
uses: 0
category: Coding
triggers: swiftui navigationstack, observable macro, swiftdata model, core data, xcode previews, react native, expo router, metro bundler, native module, testflight, app store review, info.plist usage description, scenephase, offline sync, ios simulator, eas build
---

## When
App architecture and platform concerns for iOS (SwiftUI) or cross-platform (React Native/Expo). Creating or building an Xcode project step by step: read swift-ios-app.

## SwiftUI structure
1. Navigation: one `NavigationStack(path:)` per tab with a typed path (`[Route]` enum, `navigationDestination(for:)`). Deep links push onto that path. Sheets for modal tasks, not for drill-down.
2. State: `@State` for view-local values; `@Observable` model classes (iOS 17+) owned by an ancestor and passed down or put in `.environment`; `@Bindable` to bind into them. Older targets: `ObservableObject` + `@StateObject` (owner) / `@ObservedObject` (non-owner). Wrong owner = state resets on re-render.
3. Persistence: SwiftData (`@Model`, `.modelContainer`, `@Query`) for iOS 17+ local data; Core Data when you need older OS support or mature migration tooling. Plan schema versions before shipping v1. Small prefs go in `@AppStorage`; secrets in Keychain only.
4. Async: `.task {}` ties work to view lifetime and cancels on disappear. UI updates on `@MainActor`.
5. Previews: give every screen a preview with an in-memory container and sample data; if previews break, the view has hidden dependencies.

## React Native / Expo
- Prefer Expo (managed + dev client) unless you need an unsupported native SDK; `npx expo prebuild` generates native folders when you do.
- Metro is the bundler: on weird module errors run `npx expo start -c` (clear cache) before anything else.
- Native modules: after adding one, rebuild the dev client; a JS reload is not enough. Check the library supports the New Architecture for your RN version.
- Platform differences: `Platform.OS`, `.ios.tsx`/`.android.tsx` files, safe areas (`react-native-safe-area-context`), Android back button, keyboard avoidance differs per platform.
- Lists: `FlatList`/`FlashList` with stable `keyExtractor`, never `map` over hundreds of items in a ScrollView.

## Cross-cutting
- Offline: treat the local store as the source for UI; queue writes with ids and retry when connectivity returns; resolve conflicts explicitly (last-write-wins or server merge). Show stale/syncing state.
- Permissions: ask in context, right before the feature needs it; handle denied and "limited" states; add every `NS...UsageDescription` to Info.plist (missing keys crash on request and fail review). Android: declare in the manifest and request at runtime.
- Lifecycle: observe `scenePhase` / `AppState`. On background, save drafts and pause timers; on foreground, refresh stale data. Assume the OS may kill you at any time in the background.

## Pitfalls
- Doing network or disk work in `body` or render; heavy work in `init` of a view.
- Navigation state held in multiple places, so back behaves oddly.
- Testing only on the simulator: camera, push, background fetch, performance and memory differ on device.

## Verify
- Build and run on the simulator: `xcodebuild -scheme App -destination 'platform=iOS Simulator,name=iPhone 16' test`; for Expo `npx expo run:ios`.
- Test rotation, Dynamic Type at the largest size, dark mode, airplane mode, permission denied, and kill-and-relaunch.

## TestFlight / App Store checklist
1. Bump version and build number; set the release scheme and signing team.
2. App icons, launch screen, privacy manifest (`PrivacyInfo.xcprivacy`) and accurate privacy nutrition labels.
3. Every permission string present and specific; no placeholder text or crashing debug menus.
4. Archive, upload (Xcode Organizer or `eas submit`), add test notes, internal testers first.
5. Review notes with a demo login if the app needs an account; account deletion in-app if you offer sign-up.
