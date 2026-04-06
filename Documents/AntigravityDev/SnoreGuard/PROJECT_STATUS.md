# SnoreGuard - Project Status & Context
**Last Updated**: April 6, 2026
**Status**: Pre-Launch — detection tuning in progress, watch delivery simplified to mirrored phone notifications

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture](#architecture)
3. [Current Bugs (Blocking)](#current-bugs-blocking)
4. [Troubleshooting History](#troubleshooting-history)
5. [Completed Features](#completed-features)
6. [Key Technical Details](#key-technical-details)
7. [File Structure](#file-structure)
8. [Testing & Deployment](#testing--deployment)
9. [Next Steps](#next-steps)

---

## Project Overview

**SnoreGuard** is an iOS app that detects snoring using Core ML and sends native iPhone notifications that may mirror to Apple Watch.

### Core Features
- ✅ Real-time snore detection using ML (Core ML Sound Classifier)
- ✅ Apple Watch notification mirroring via iPhone local notifications
- ✅ Sleep session analytics (score, events, audio graph)
- ✅ Configurable sensitivity levels (High/Medium/Low) — persistent
- ✅ Persistent session history (AsyncStorage + native disk)
- ✅ Detailed logging system (has data consistency issues — see bugs)
- ⚠️ Daily reminder notifications — NOT FIRING reliably
- ✅ Monetization paywall (IAP wired up, pending App Store Connect product creation)

### Tech Stack
- **Frontend**: React Native (Expo managed workflow with prebuild)
- **Native Modules**: Swift (iOS), Objective-C bridge
- **ML**: Core ML Sound Classifier (custom-trained)
- **Audio Processing**: AVFoundation, SoundAnalysis framework
- **Watch**: Notification mirroring from iPhone to Apple Watch
- **Storage**: AsyncStorage (JS), native iOS file system (Swift)
- **IAP**: react-native-iap v14.7.12

---

## Architecture

### Detection Flow
```
1. iPhone microphone → AVAudioEngine
2. Audio buffer → NativeAudioRecorder.swift
3. ML Model (SnoreClassifier.mlmodel) → Snore confidence score
4. Confidence threshold + sustained classification gate → Trigger
5. Trigger → iPhone notification (NotificationBridge)
6. watchOS may mirror that notification to Apple Watch with standard system haptics
7. Session data points logged to SleepSessionBridge (in-memory + disk flush every 10 points)
```

### Watch Delivery Flow (Current)
```
iPhone App.js
  → NotificationBridge.scheduleImmediateNotification()
  → iOS local notification fires
  → Apple Watch may mirror the notification
  → Watch uses standard mirrored-notification haptic (single system pulse)
```

### Key Components

**Native iOS (Swift)**:
- `NativeAudioRecorder.swift`: Audio recording, ML inference, event detection
- `SleepSessionBridge.swift`: Session data persistence (in-memory + disk flush)
- `NotificationBridge.swift`: Local notification handling

**React Native (JavaScript)**:
- `App.js`: Main UI, session management, analytics, IAP, notifications
- `SnoreDetector.js`: JavaScript wrapper for native audio module

---

## Current Bugs (Blocking)

### Bug 1: Mirrored Watch Notifications Only Give 1 Pulse

**User report**: Notifications come through fine on the Watch (single tap) but never feel like 5 distinct rapid pulses.

**Decision**:
We are intentionally using iPhone local notifications and relying on Apple’s mirrored-notification behavior on Watch.

**Current understanding**:
- Mirrored notifications produce the standard watchOS haptic, which is effectively a single system pulse.
- Achieving a reliable custom 5-pulse pattern would require a real Watch app lifecycle, watch installation, activation, and overnight runtime management.
- That complexity is out of scope for the current product direction.

**What to investigate next**:
- Do not spend more time on custom WatchConnectivity haptics for now.
- Revisit a dedicated Watch app only if multi-pulse haptics become a launch-critical requirement.

---

### Bug 2: Detection Can Miss or Under-Count Some Snore Events

**User report**: The app appears to miss some snoring events, and historical logging has sometimes under-counted events compared to what was actually detected.

**Root cause analysis**:

There are TWO different causes:
1. **Detection gating may be too strict**: the native classifier only runs above a minimum power gate and only fires after passing a confidence threshold over sustained windows.
2. **Notification cooldown was also limiting event counting**: ML detections inside the 10-second cooldown window were not being counted in analytics, which made detection look worse than it really was.

**Recent fix applied April 6, 2026**:
- ML detections are now counted even when user-facing notifications are suppressed by cooldown.
- Native ML thresholds were loosened modestly to improve sensitivity to quieter snoring.

**Remaining design tension**:
- dB threshold samples and ML detections still measure different things.
- A quiet but valid ML snore may still not appear as a high-dB sample in the 5-second graph data.

**What to investigate next**:
- Validate overnight whether the new ML count behavior better matches perceived snoring frequency.
- If the app still misses real events, consider one more round of ML threshold tuning before touching the UI sensitivity presets.

---

### Bug 3: Daily 7 PM Reminder Not Firing

**User report**: It is 7 PM and no notification came through.

**Root cause analysis**:
Multiple approaches have been tried:

1. **Attempt 1** (Feb 23): Used `{ seconds: secondsUntilNext, repeats: false }` one-shot trigger — fired once but didn't repeat nightly.
2. **Attempt 2** (Mar 3): Changed to `{ hour: 19, minute: 0, repeats: true }` calendar trigger — NOT FIRING.
3. **Known issue with calendar trigger**: On Expo SDK 52 + iOS, `{ hour, minute, repeats: true }` requires the `channelId` field on Android. On iOS, this should work but may conflict with `Notifications.setNotificationHandler` or permissions state.

**Possible causes not yet investigated**:
- The notification permission may not include "time-sensitive" or "scheduled" delivery. The app only calls `requestPermissionsAsync()` which may grant alert permission but not scheduled delivery.
- The `data: { type: 'daily-reminder' }` filter used to cancel old reminders — if this data tag is not preserved properly on iOS, the cancel loop may cancel everything OR miss old ones.
- Expo Notifications v0.29.x may have a known bug with repeating calendar triggers on iOS 18.
- Device notification settings: user may have Focus mode or "Scheduled Summary" enabled, which delays/batches notification delivery.
- The reminder scheduling useEffect has the flag `isInitialLoadComplete` — if this flag is never set to `true` for some reason, `scheduleDailyReminder()` never runs.

**What to investigate next**:
- Check if `Notifications.getAllScheduledNotificationsAsync()` returns any scheduled reminders after app launch
- Check if the trigger format needs `timezone` specification
- Test with `trigger: { seconds: 10 }` to confirm notifications work at all from this code path
- Check iOS Settings → SnoreGuard → Notifications → Scheduled Delivery setting
- Consider switching from Expo Notifications to `NotificationBridge.scheduleImmediateNotification` for the daily reminder (native UNUserNotificationCenter is more reliable)

---

## Troubleshooting History

### Session 1 (Nov 2025): Initial Development
- Created project structure, basic snore detection, Watch connectivity skeleton

### Session 2 (Feb 19-20, 2026): First Overnight Test
- Fixed graph timestamps, log accumulation, analytics persistence
- Fixes: chart label overlap, log file appending, Last Session card

### Session 3 (Feb 23, 2026): Detection Fixes
- **Removed** WatchConnectivity VIBRATE code (believed iOS mirroring was sufficient)
- Fixed snore event counter (phantom 100+ events from audio metering tick)
- Fixed -160 dB chart outlier at session start
- Tuned ML thresholds: `mlMinimumPowerThreshold -55 → -65 dB`, `requiredConsecutiveCount 6 → 4`
- Reduced log verbosity (audio level every 5 min not 10 sec)
- Fixed daily reminder firing immediately (one-shot trigger with seconds-until-next calculation)

### Session 4 (Mar 3, 2026): Sensitivity, Watch Haptics, Persistence
- Re-added WatchConnectivity VIBRATE (mirroring alone = 1 vibration, not customizable)
- Added `sensitivityRef` (useRef) to fix stale closure bug in session recovery
- Persistence: `AsyncStorage.setItem('sensitivity', value)` on change, load on mount
- Fixed session recovery order: sensitivity must load BEFORE `checkRecoveredSession` runs
- Fixed Watch app WCSession: added `_ = WatchConnectivityManager.shared` to `SnoreGuardApp.init()`
- Added Watch command handlers in `WatchConnectivityManager` for VIBRATE
- SleepSessionBridge: added disk flush every 10 data points (survives iOS kills)
- Daily reminder: changed from `{ seconds: N }` back to `{ hour, minute, repeats: true }`
- Session summary notification: changed from 1-hour delay to immediate (`trigger: null`)
- Bundle ID changed: `com.antigravity → com.agenticdevlabs` (DUNS number change)
- Added `-allowProvisioningUpdates` to `deploy_model.py`

### Session 5 (Mar 4-5, 2026): Score/Log/Haptics Fixes
- Fixed `HapticManager`: background thread → `DispatchQueue.main.asyncAfter` (main thread)
- Added `START_SESSION`/`STOP_SESSION` handlers in `WatchConnectivityManager` to start `ExtendedRuntimeManager`
- Fixed `calculateSnoreScore`: now uses `Math.max(dbEvents, mlEventCount)` for consistency
- Fixed false SESSION RECOVERED: `stopMonitoring` now calls `clearNativeData()` after AsyncStorage save
- Fixed recovery log: now reads ML count from AsyncStorage and reports both counts
- **User tested same night — none of the 3 issues resolved**

---

## Completed Features

### ✅ Core Detection
- ML-based snore detection (60% confidence threshold, 2 consecutive windows)
- Minimum power threshold (-70 dB) to avoid classifying silence
- dB threshold filtering (configurable via sensitivity)
- ML detections are counted even when notification delivery is throttled by cooldown

### ✅ UI/UX
- Home screen with monitoring controls
- Real-time audio level display
- Sensitivity selector (High/Medium/Low) — persists across launches
- Analytics screen: snore score, event count, average dB, audio graph
- Last Session card on home screen
- Paywall modal (full UI, pending App Store Connect products)

### ✅ Monetization (Code Complete)
- `react-native-iap` v14.7.12 integrated
- Product IDs: `com.agenticdevlabs.snoreguard.monthly`, `com.agenticdevlabs.snoreguard.annual`
- Prices: $6.99/month, $49.99/year, 3-day free trial
- Gift codes: SNOREGUARD-PARTNER-2026, SNOREGUARD-PRESS-2026, SNOREGUARD-VIP-001/002/003 (30-day access)
- Paywall gated on `startMonitoring`
- Restore Purchases button present (Apple requirement)
- **Blocked on**: DUNS number → Apple Developer account → App Store Connect product creation

---

## Key Technical Details

### ML Model Parameters
```swift
// NativeAudioRecorder.swift
snoreConfidenceThreshold: 0.60          // ML must be 60% confident
requiredConsecutiveCount: 2             // Sustained for ~1 second
mlMinimumPowerThreshold: -70.0 dB       // Skip ML inference for near-silence
windowDuration: 1.0 second
overlapFactor: 0.5                      // Windows 0.5s apart
```

### Sensitivity Thresholds (dB)
```javascript
// App.js — used for LOG filtering and SCORE calculation, NOT for ML detection
SENSITIVITY_LEVELS = {
  High: -32,    // ~6 dB above white noise floor (-38 to -42 dB)
  Medium: -22,  // Clearly audible snoring
  Low: -15      // Only loud snoring
}
// IMPORTANT: Real snoring detected by ML is at ~-51.7 dB
// This means ML fires correctly but dB threshold events = 0 almost always
// Score and log use Math.max(dbEvents, mlEvents) to avoid showing 0 incorrectly
```

### Data Collection
- Audio samples logged every **5 seconds** to sessionData
- Audio level events emitted every **~100ms** (tap callback)
- SleepSessionBridge: flushes to disk every **10 data points** (~50 seconds)

### Score Calculation (Updated Mar 5)
```javascript
effectiveEventCount = Math.max(dbThresholdEvents, mlDetectedEvents)
Score = (snorePercentage × 0.7) + (avgIntensity × 0.3)
// Lower score = better sleep
// mlEventCount passed to calculateSnoreScore from all call sites
```

### Watch Haptic Config
```swift
// AppConfig.swift
hapticPulseCount: 5
hapticPulseDuration: 0.3 seconds
// Pulses fired at: 0s, 0.3s, 0.6s, 0.9s, 1.2s on main thread
```

---

## File Structure

```
SnoreGuard/
├── App.js                              # Main React Native UI & logic
├── SnoreDetector.js                    # Audio detection wrapper
├── app.json                            # Expo config
├── package.json                        # Dependencies
├── deploy_model.py                     # ⭐ Build & deploy to iPhone
│
├── ios/
│   ├── SnoreGuard.xcworkspace          # Xcode workspace
│   ├── SnoreGuard/
│   │   ├── AppDelegate.mm              # App lifecycle
│   │   ├── Info.plist                  # iOS permissions & config
│   │   ├── NativeAudioRecorder.swift   # ⭐ Core ML detection
│   │   ├── NativeAudioRecorderBridge.m # React Native bridge
│   │   ├── SleepSessionBridge.swift/m  # Session persistence (in-mem + disk)
│   │   ├── WatchConnectivityBridge.swift/m  # Legacy/stub watch bridge retained for build compatibility
│   │   ├── NotificationBridge.swift/m  # Local notifications
│   │   └── SnoreClassifier.mlmodel     # ML model
│   │
│   └── [No Watch app source present in current checkout]
│
├── MySoundClassifier.mlproj/           # Create ML project
├── training_data/                      # ML training audio
├── PROJECT_CONTEXT.md                  # Original handover doc
└── PROJECT_STATUS.md                   # ⭐ This file
```

---

## Testing & Deployment

### Device Info
- **iPhone Device ID**: `99C20B85-2B42-51CD-9767-6B0CE17A0491`
- **Team ID**: `TDSR3ULM7K`
- **Bundle ID**: `com.agenticdevlabs.snoreguard`

### Build & Deploy
```bash
# Full build, install, and launch
python3 deploy_model.py
```

### Overnight Test Results

| Date | Events | Score | Sensitivity | Issues |
|------|--------|-------|-------------|--------|
| Feb 19-20 | 9 | 15/100 | Default | Chart, log, analytics bugs |
| Feb 23 | ~1 | Low | High | Very few events — ML threshold too tight |
| Mar 3-4 | 14 (ML) | 0 (bug) | High | Score showed 0, logs showed 0, 1 Watch pulse |
| Mar 4-5 | TBD | TBD | High | Same 3 issues reported — fixes unconfirmed |
| Apr 6-7 | Pending | Pending | User choice | Release build installed; testing tuned detection + mirrored notification path |

---

## Next Steps (Priority Order)

### Priority 1: Validate Current Detection + Reminder Behavior
1. **Daily reminder**: Debug why `{ hour: 19, minute: 0, repeats: true }` isn't firing. Check scheduled notifications list, test shorter interval, consider native UNUserNotificationCenter instead of Expo.
2. **Detection accuracy**: Validate whether the April 6 ML threshold changes reduce missed snore events without introducing too many false positives.
3. **Log/score consistency**: Confirm overnight analytics now reflect every sustained ML detection even when alert notifications are on cooldown.

### Priority 2: App Store Submission (Blocked on DUNS)
- DUNS number pending → Apple Developer account enrollment → App Store Connect
- Once approved: create subscription products, enable sandbox testing
- Prepare: screenshots, privacy policy URL, app description

### Priority 3: ML Model Refinement (Post-Launch)
- Training data: add more real snoring samples
- Consider lowering sensitivity threshold to better match ML detection range (-51 dB snoring vs -32 dB threshold)
- Fine-tune `requiredConsecutiveCount` if false positives appear

---

## Known Design Tensions

1. **ML vs dB threshold**: ML detects snoring at -51.7 dB. Sensitivity thresholds start at -32 dB (High). These two systems will never agree unless thresholds are lowered or ML events are stored differently.

2. **Mirrored Watch behavior**: Apple Watch mirroring gives the app very little control over pulse count or delivery feel. If custom haptics ever become mandatory, that likely means reviving a real Watch app architecture.

3. **Notification reliability**: iOS can delay, batch, or suppress notifications in Focus mode, Do Not Disturb, or Scheduled Summary. The app has no control over this at runtime.

---


## 2026-03-05 — iOS stabilization + handoff update

### Current outcome
- App launches and runs on physical iPhone successfully.
- Install path validated for **no Metro requirement at runtime**.

### Changes applied

#### 1) Watch vibration path (scope reduction by design)
- Removed reliance on custom Watch app/WatchConnectivity behavior for vibration control.
- Product behavior now uses iPhone local notifications only (which mirror to Apple Watch when iOS/watchOS allow it).
- The prior “5 pulses on watch” requirement is treated as non-guaranteed under mirrored notifications (platform limitation).
- During cleanup, native watch bridge source deletion broke iOS target references; temporary no-op bridge stubs were restored to keep build green until project references are fully cleaned.

#### 2) Session logs missing after stop (data persistence hardening)
- Final session sync path was hardened:
  - retry window added for final native snapshot read,
  - avoid overwriting non-empty in-memory session data with empty/native-lag values,
  - preserve finalize order: final sync -> persist log -> clear session state.
- Goal: prevent “no data in logs after session” race condition.

#### 3) Daily reminder reliability
- Reminder scheduling logic hardened:
  - cancel stale prior reminder entries before scheduling,
  - schedule daily trigger and maintain a same-time fallback one-shot,
  - do not block toggle-on scheduling behind initial-load gating.
- Known external factors remain: Focus mode / iOS notification suppression behavior.

### Build/debug notes from this cycle
- Initial build failures were caused by:
  1) deleted native files still referenced by Xcode target,
  2) removed `ios/build` artifacts required by ReactCodegen compile inputs in this setup.
- Recovery path used:
  - `pod deintegrate`
  - remove Pods/lock/build
  - `pod install --repo-update`
  - clear DerivedData
  - rebuild.

### Operational command used to install runnable app to phone
- Dev install (normal): `npx expo run:ios --device`
- Release/no-bundler install: `npx expo run:ios --device --configuration Release --no-bundler`

### Known constraints (explicit)
- Mirrored iPhone notifications on Watch do **not** provide deterministic custom haptic pulse count.
- ML snore detection and dB sensitivity threshold are distinct systems; partial divergence is expected by architecture.
- iOS notification delivery can still be suppressed by system policy/user settings.

### Suggested next handoff tasks
1. Decide whether to leave the legacy watch bridge stub in place or fully remove its Xcode references in `project.pbxproj`.
2. Run one overnight validation pass for:
   - log persistence after end-session,
   - reminder delivery at scheduled time,
   - score/log consistency in end-session summary.
3. Capture validation evidence in this file (timestamp + device/iOS version + result).

---

## 2026-04-06 — Detection tuning + Release install for overnight test

### Current outcome
- Release build installed successfully to connected physical iPhone.
- User trusted the developer profile on-device and confirmed the app launches.
- Overnight test is planned for tonight.

### Changes applied

#### 1) Product direction clarified
- Active alert path is now iPhone native local notifications with optional Apple Watch mirroring.
- Custom WatchConnectivity-driven 5-pulse haptics are no longer the active implementation target.
- The single mirrored watch vibration is treated as current expected platform behavior.

#### 2) Detection/event counting tuning
- `App.js`
  - Removed the active WatchConnectivity vibrate call from the snore-detection flow.
  - ML detections now increment analytics even when the 10-second notification cooldown suppresses another alert.
  - Goal: stop under-counting real snore detections simply because alerts are rate-limited.
- `ios/SnoreGuard/NativeAudioRecorder.swift`
  - Lowered `snoreConfidenceThreshold` from `0.70` to `0.60`.
  - Lowered `mlMinimumPowerThreshold` from `-65.0` to `-70.0`.
  - Goal: improve capture of quieter snoring before changing user-facing sensitivity presets.

#### 3) Documentation/handoff updates
- Updated architecture/status language to match the mirrored-notification approach.
- Added `Codex_to_Claude.md` to summarize the latest implementation and deployment context for Claude.

### Release build/install notes
- Physical device used:
  - `00008130-00023C313CA2001C`
- Release app bundle produced at:
  - `ios/build/Build/Products/Release-iphoneos/SnoreGuard.app`
- Successful install command:
  - `xcrun devicectl device install app --device 00008130-00023C313CA2001C ios/build/Build/Products/Release-iphoneos/SnoreGuard.app`
- Launch via `devicectl` initially failed due to trust/profile security until the developer profile was trusted manually on the iPhone.

### Validation target for tonight
1. Does the app still miss real snoring events after the April 6 tuning?
2. Do analytics counts feel closer to perceived snore frequency?
3. Did the looser ML thresholds introduce noticeable false positives?
