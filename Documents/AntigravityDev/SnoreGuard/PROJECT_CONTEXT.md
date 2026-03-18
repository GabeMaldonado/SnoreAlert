# Project Context & Handover

**To**: Agent on Mac
**From**: Agent on Windows
**Date**: 2025-11-23
**Project**: SnoreGuard (Silent Wake App)

## 1. Project Overview
The user wants to build an iOS app that detects snoring and triggers a **haptic vibration on the Apple Watch** to wake the user.
- **Platform**: iOS (Primary) + WatchOS (Companion).
- **Core Feature**: Real-time audio analysis on iPhone -> Signal Watch -> Watch Vibrates.

## 2. Current State
- **Windows Machine**: Lacked Node.js/Git.
- **Files Created**:
    - `package.json`: Standard Expo + `expo-av` + `expo-haptics`.
    - `app.json`: Configured with microphone permissions and background audio modes.
    - `App.js`: Basic UI scaffold (Start/Stop buttons).
- **Missing**:
    - `node_modules` (User needs to run `npm install` on Mac).
    - `ios/` and `android/` folders (User needs to run `npx expo prebuild` on Mac).

## 3. Architecture Decisions
- **Framework**: React Native (Expo Managed Workflow with Prebuild).
    - *Why*: Ease of UI dev, but allows native code for Watch connectivity.
- **Watch Integration**:
    - We cannot use Expo for the Watch app itself.
    - We must create a **Native Swift Watch Target** in Xcode.
    - **Communication**: Use `WCSession` (WatchConnectivity) to send "VIBRATE" command from iPhone to Watch.
    - **Background**: Watch app needs a `HKWorkoutSession` or `WKExtendedRuntimeSession` to stay active and receive commands immediately.

## 4. Implementation Plan (Approved)

### Phase 1: Setup (Done on Windows)
- [x] Create `package.json`, `app.json`, `App.js`.

### Phase 2: Core Logic (Next on Mac)
- [ ] **Install Dependencies**: Run `npm install`.
- [ ] **Prebuild**: Run `npx expo prebuild` to generate the native iOS project.
- [ ] **Snore Detection**: Implement `SnoreDetector.js` using `expo-av` to analyze audio levels (decibels).

### Phase 3: Native Watch Implementation (Mac Only)
- [ ] **Open Xcode**: Open `ios/SnoreGuard.xcworkspace`.
- [ ] **Add Watch Target**: File -> New -> Target -> Watch App.
- [ ] **Bridge**: Create a Swift Native Module in the iOS app to expose `WCSession` to React Native.
- [ ] **Watch Code**: Implement `InterfaceController` on Watch to listen for messages and play Haptic.

## 5. Next Steps for Agent
1.  Ask user to run `npm install`.
2.  Ask user to run `npx expo prebuild`.
3.  Open the project in Xcode and guide the user to add the Watch App target.
4.  Implement the Swift Bridge for WatchConnectivity.

## 6. Key Files
- `App.js`: Main UI.
- `app.json`: Config.
