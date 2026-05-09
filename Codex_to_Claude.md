# Codex to Next Agent

Date: 2026-05-09
Project: SnoreGuard / SnoreAlert

## Summary
- The active implementation now includes a native Apple Watch companion app again.
- The iPhone app calls `WatchConnectivityBridge` for session start/stop and haptic alert delivery.
- The watch app has WCSession handling, haptics, extended runtime support, and a small scrollable status UI.
- Release signing was refreshed with `-allowProvisioningUpdates`; iPhone install and Xcode watch-target install succeeded on May 6, 2026.
- Detection false positives from random loud sounds were reduced by preventing raw dB threshold alerts from firing while ML mode is active.
- Opt-in Training Audio Capture was added for collecting real sleep/session audio as future ML training data.

## Code Changes Since April Handoff
- `App.js`
  - Added Training Audio Capture setting persisted in AsyncStorage.
  - Passes training capture setting to `SnoreDetector`.
  - Logs saved training recording path after session stop.
  - Keeps watch session bridge calls in the session lifecycle.
- `SnoreDetector.js`
  - Added `setTrainingRecordingEnabled()` and `getLastTrainingRecordingPath()`.
  - Starts native monitoring with `{ saveTrainingRecording }`.
  - Uses ML snore-confidence events as the alert source when `mlActive` is true.
- `ios/SnoreGuard/NativeAudioRecorder.swift`
  - Added optional `.caf` session recording under app Documents:
    `SnoreGuardTrainingSessions/snoreguard-training-yyyyMMdd-HHmmss.caf`.
  - Returns/announces `trainingRecordingPath`.
- `ios/SnoreGuard Watch App Watch App/`
  - Watch companion source exists and must be committed/pushed with the Xcode project wiring.

## Build / Install Notes
- Main iPhone Release build command used:
  `xcodebuild -workspace ios/SnoreGuard.xcworkspace -scheme SnoreGuard -configuration Release -destination id=00008130-00023C313CA2001C -allowProvisioningUpdates build`
- iPhone install used:
  `xcrun devicectl device install app --device 99C20B85-2B42-51CD-9767-6B0CE17A0491 <DerivedData>/Release-iphoneos/SnoreGuard.app`
- Direct watch `devicectl` install timed out in CoreDevice.
- Xcode watch-target install succeeded:
  `xcodebuild -workspace ios/SnoreGuard.xcworkspace -scheme "SnoreGuard Watch App Watch App" -configuration Release -destination id=00008301-A88804C00E98C02E -allowProvisioningUpdates install`

## Next Recommended Work
1. Confirm all intended source/docs/model assets are committed and pushed before moving to the new MacBook Pro.
2. On the new Mac, install dependencies, run `pod install`, open `ios/SnoreGuard.xcworkspace`, and verify signing.
3. Run an overnight test with Training Audio Capture enabled.
4. Use captured `.caf` files to build a better snore/non-snore training set, especially partner-verified snore examples and random household noise negatives.
