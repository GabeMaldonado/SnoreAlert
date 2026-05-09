# Project Context & Handover

**Date**: 2026-05-09
**Project**: SnoreGuard / SnoreAlert
**Repo**: `https://github.com/GabeMaldonado/SnoreAlert.git`

## Current Product State
SnoreGuard is a React Native/Expo iOS app with native Swift modules for audio analysis, Core ML snore detection, local notifications, session persistence, and Apple Watch companion support.

The current active direction is a real iPhone app plus native watchOS companion. The iPhone records/analyzes microphone audio, starts/stops watch sessions through `WatchConnectivityBridge`, and sends haptic alert commands to the watch when a snore event is detected.

## Recent Critical Work
- Rebuilt and integrated the Apple Watch companion into the iPhone app target.
- Added real watchOS files under `ios/SnoreGuard Watch App Watch App/`.
- Added WatchConnectivity handling, watch haptics, extended runtime support, and a minimal status UI.
- Fixed Release signing/provisioning enough for successful iPhone Release install and watch target install.
- Added opt-in Training Audio Capture so real sleep sessions can be saved locally as `.caf` files for future ML training.
- Fixed a false-positive path where raw loud dB events could trigger alerts even while ML mode was active.

## Key Files
- `App.js`: main app UI, session lifecycle, settings, watch bridge calls, training capture toggle.
- `SnoreDetector.js`: JS wrapper around native audio recorder and snore event routing.
- `ios/SnoreGuard/NativeAudioRecorder.swift`: AVAudioEngine, SoundAnalysis/Core ML, training audio capture.
- `ios/SnoreGuard/NativeAudioRecorder.m`: React Native bridge exports.
- `ios/SnoreGuard/WatchConnectivityBridge.swift`: iPhone-side watch bridge.
- `ios/SnoreGuard Watch App Watch App/`: native watchOS companion source.
- `ios/SnoreGuard.xcodeproj/project.pbxproj`: target wiring for iPhone + Watch.
- `MySoundClassifier.mlproj/`: Create ML sound classifier project.
- `training_data/`: current local/generated training data corpus.

## Known Current Issues / Risks
- watchOS can still limit overnight/background runtime; validate with real overnight tests.
- Watch direct install via `devicectl` can time out in CoreDevice. Xcode watch-target install succeeded.
- Training Audio Capture is local-only. There is no export/upload workflow yet.
- Root repo recently gained `.gitignore`; generated folders should stay out of git.

## New Mac Setup Summary
Install Xcode, Xcode Command Line Tools, Node/npm, CocoaPods, and Expo tooling. Then:

```sh
npm install
cd ios
pod install
open SnoreGuard.xcworkspace
```

Use Xcode automatic signing with the Apple Developer team `TDSR3ULM7K` / Gabriel Maldonado. Build the `SnoreGuard` scheme for iPhone Release, and if needed build/install `SnoreGuard Watch App Watch App` directly to the paired watch.
