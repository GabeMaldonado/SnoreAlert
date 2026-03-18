# SnoreGuard - Project Status & Context
**Last Updated**: March 5, 2026
**Status**: Pre-Launch — 3 persistent bugs blocking production quality

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

**SnoreGuard** is an iOS app that detects snoring using Core ML and triggers haptic vibrations on Apple Watch to wake the user.

### Core Features
- ✅ Real-time snore detection using ML (Core ML Sound Classifier)
- ✅ Apple Watch haptic feedback (single pulse — 5-pulse NOT YET WORKING)
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
- **Watch**: WatchConnectivity framework + WKExtendedRuntimeSession
- **Storage**: AsyncStorage (JS), native iOS file system (Swift)
- **IAP**: react-native-iap v14.7.12

---

## Architecture

### Detection Flow
```
1. iPhone microphone → AVAudioEngine
2. Audio buffer → NativeAudioRecorder.swift
3. ML Model (SnoreClassifier.mlmodel) → Snore confidence score
4. Confidence > 0.85 for 4 consecutive windows → Trigger
5. Trigger → iPhone notification (NotificationBridge) + Watch VIBRATE command (WatchConnectivityBridge)
6. Watch receives VIBRATE via WCSession → HapticManager.playSnoreDetectedHaptics()
7. Session data points logged to SleepSessionBridge (in-memory + disk flush every 10 points)
```

### Watch Communication Flow (Current)
```
iPhone App.js
  → WatchConnectivityBridge.sendVibrateCommand()
  → WCSession (3 delivery paths: updateApplicationContext, transferUserInfo, sendMessage)
  → Watch WatchConnectivityManager.handleCommand("VIBRATE")
  → HapticManager.playSnoreDetectedHaptics()  ← 5 pulses scheduled on main thread
```

### Key Components

**Native iOS (Swift)**:
- `NativeAudioRecorder.swift`: Audio recording, ML inference, event detection
- `SleepSessionBridge.swift`: Session data persistence (in-memory + disk flush)
- `WatchConnectivityBridge.swift`: Watch communication (iPhone side)
- `NotificationBridge.swift`: Local notification handling

**Watch App (Swift)**:
- `WatchConnectivityManager.swift`: Receives commands from iPhone, handles START/STOP/VIBRATE
- `HapticManager.swift`: 5-pulse haptic pattern using DispatchQueue.main.asyncAfter
- `ExtendedRuntimeManager.swift`: Keeps Watch app alive overnight via WKExtendedRuntimeSession
- `AppConfig.swift`: `hapticPulseCount = 5`, `hapticPulseDuration = 0.3s`

**React Native (JavaScript)**:
- `App.js`: Main UI, session management, analytics, IAP, notifications
- `SnoreDetector.js`: JavaScript wrapper for native audio module

---

## Current Bugs (Blocking)

### Bug 1: Watch Haptics — Still Only 1 Pulse (Not 5)

**User report**: Notifications come through fine on the Watch (single tap) but never feels like 5 distinct rapid pulses.

**Root cause analysis**:
Multiple fixes have been applied without resolving the issue:

1. **Attempt 1** (not done initially): `WatchConnectivityBridge.sendVibrateCommand()` was never called from App.js — FIXED.
2. **Attempt 2**: `WatchConnectivityManager.shared` was not initialized on Watch app launch — FIXED in `SnoreGuardApp.init()`.
3. **Attempt 3**: `HapticManager` was calling `WKInterfaceDevice.current().play()` from a background thread with `Thread.sleep` — FIXED to use `DispatchQueue.main.asyncAfter` with staggered offsets.
4. **Attempt 4**: Watch app was suspended overnight. Added `START_SESSION`/`STOP_SESSION` command handlers in `WatchConnectivityManager` to start `ExtendedRuntimeManager` — FIXED in code but **untested overnight yet**.

**Remaining uncertainty**:
- `WKExtendedRuntimeSession` has a maximum duration (~10 minutes for "self care" sessions, or unlimited for workout sessions). The session type in `ExtendedRuntimeManager` uses the default type — may be expiring before morning.
- The Watch app `ContentView` is a placeholder ("Hello, world!"). There is NO UI that starts the extended runtime session automatically — it only starts when iPhone sends `START_SESSION`, which requires WCSession to deliver the message when Watch app is first activated.
- The user must have the Watch app OPEN (or at least launched once) to activate WCSession on the Watch side. If the Watch was never opened, WCSession is never activated and no commands are received.
- The standard iOS notification IS mirroring to Watch and causing 1 vibration. This is what the user feels — the WatchConnectivity VIBRATE command may never be reaching the Watch app.

**What to investigate next**:
- Confirm whether Watch app has ever been opened by user
- Check if ExtendedRuntimeSession is actually starting (check Watch app logs)
- Consider using workout-type extended runtime session for unlimited duration
- Consider whether notification mirroring is the ONLY viable path (always 1 vibration) and if Watch Notification Extension is needed for custom 5-pulse pattern

---

### Bug 2: Session Logs Show Wrong/No Events

**User report**: App logs say "0 events detected" or no session data, while the analytics screen shows 14 snore events. Data doesn't match.

**Root cause analysis**:

There are TWO separate event-counting systems that disagree:
1. **ML detections** (`snoreCountRef.current`): Incremented in real-time every time the snore callback fires. This is what the analytics "Snore Events" card shows (14).
2. **dB threshold crossings** (`sessionData.filter(d => d.level > threshold)`): Data points are sampled every 5 seconds. The ML classifier catches snoring at `-51.7 dB` but the sensitivity threshold (High = `-32 dB`) is set much louder. So ML detections fire but no 5-second sample happens to be above `-32 dB` at that exact moment.

**The mismatch**: The analytics shows 14 (ML count), the log shows 0 (dB count). Both are "correct" by their own definition but are contradictory to the user.

**Secondary issue — false SESSION RECOVERED log**:
After a session ends normally (`stopMonitoring`), `SleepSessionBridge.stopSleepSession()` flushes the final data to disk but does NOT clear the file. On next launch, `syncDataFromNative()` finds this data and logs "SESSION RECOVERED" with 0 dB events, ignoring the 14 ML events saved in AsyncStorage. This was FIXED to:
- Call `SleepSessionBridge.clearNativeData()` after saving to AsyncStorage in `stopMonitoring`
- Read ML count from AsyncStorage in `syncDataFromNative` and include it in the recovery log

**Score inconsistency** (same root cause):
`calculateSnoreScore` only used dB threshold count → score of 0/100 with 14 events → showed "😴 Excellent sleep!" despite real snoring. FIXED to use `Math.max(dbEvents, mlEvents)` so ML detections contribute to the score.

**What to investigate next**:
- The SESSION RECOVERED fix has not been validated overnight yet (fix deployed March 4, user tested same night but this fix only shows on the SUBSEQUENT launch)
- The core design tension: dB threshold is calibrated for white noise floor avoidance (-32 dB) but ML detects snoring at -51 dB. The two systems measure different things. Consider: should sensitivity threshold be lowered, or should ML detections be logged as dB events in sessionData?

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
- ML-based snore detection (85% confidence threshold, 4 consecutive windows)
- Minimum power threshold (-65 dB) to avoid classifying silence
- dB threshold filtering (configurable via sensitivity)

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
snoreConfidenceThreshold: 0.85          // ML must be 85% confident
requiredConsecutiveCount: 4             // Sustained for ~2 seconds
mlMinimumPowerThreshold: -65.0 dB       // Skip ML inference for silence
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
│   │   ├── WatchConnectivityBridge.swift/m  # Watch communication (iPhone side)
│   │   ├── NotificationBridge.swift/m  # Local notifications
│   │   └── SnoreClassifier.mlmodel     # ML model
│   │
│   └── SnoreGuard Watch App Watch App/
│       ├── SnoreGuardApp.swift         # Watch app entry (activates WCSession)
│       ├── ContentView.swift           # Placeholder UI ("Hello, world!")
│       ├── WatchConnectivityManager.swift  # Receives iPhone commands
│       ├── HapticManager.swift         # 5-pulse haptic player (main thread)
│       ├── ExtendedRuntimeManager.swift    # Keeps Watch alive overnight
│       └── AppConfig.swift             # hapticPulseCount=5, pulseDuration=0.3
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

---

## Next Steps (Priority Order)

### Priority 1: Fix the 3 Blocking Bugs
1. **Daily reminder**: Debug why `{ hour: 19, minute: 0, repeats: true }` isn't firing. Check scheduled notifications list, test shorter interval, consider native UNUserNotificationCenter instead of Expo.
2. **Watch 5 pulses**: Confirm Watch app has been opened/launched at least once. Investigate ExtendedRuntimeSession type (may be time-limited). Consider if WatchConnectivity ever delivers during sleep.
3. **Log/score consistency**: The score fix is deployed — validate next overnight whether 14 ML events now produce a non-zero score. The SESSION RECOVERED fix validates on the NEXT launch after that.

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

2. **Watch background execution**: watchOS aggressively suspends apps. Extended runtime sessions help but have time limits and require the Watch app to be explicitly opened at least once. A user who never opens the Watch app will never get custom haptics — they'll only get the standard notification mirror (1 vibration).

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
1. Remove residual watch bridge file references from `project.pbxproj`, then delete temporary no-op bridge files cleanly.
2. Run one overnight validation pass for:
   - log persistence after end-session,
   - reminder delivery at scheduled time,
   - score/log consistency in end-session summary.
3. Capture validation evidence in this file (timestamp + device/iOS version + result).


