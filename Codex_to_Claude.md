# Codex to Claude

Date: 2026-04-06
Project: SnoreGuard

## Summary
- We committed to the simpler product direction: iPhone native local notifications are the real alert path, with Apple Watch mirroring as a best-effort system behavior.
- We stopped treating custom 5-pulse watch haptics as the active implementation target.
- We tuned detection to reduce missed snores and made event counts reflect all ML detections rather than only notifications that survive cooldown.

## Code changes made
- `App.js`
  - Removed the active `WatchConnectivityBridge.sendVibrateCommand()` call from the snore detection flow.
  - Kept native phone notifications as the main alert mechanism.
  - Changed ML event counting so every sustained ML hit increments analytics, even if alert delivery is suppressed by the 10-second cooldown.
- `ios/SnoreGuard/NativeAudioRecorder.swift`
  - Lowered `snoreConfidenceThreshold` from `0.70` to `0.60`.
  - Lowered `mlMinimumPowerThreshold` from `-65.0` to `-70.0`.
- `PROJECT_STATUS.md`
  - Updated docs to reflect the current alert architecture.
  - Added an April 6, 2026 entry for the latest tuning and Release install.

## Build/deploy work completed
- Built a physical-device **Release** build of SnoreGuard.
- Release app bundle exists at:
  - `ios/build/Build/Products/Release-iphoneos/SnoreGuard.app`
- Installed successfully to connected iPhone:
  - device ID: `00008130-00023C313CA2001C`
- `devicectl` install initially timed out inside sandbox, then succeeded outside sandbox.
- Launch initially failed because iOS required developer/profile trust.
- User trusted the profile on-device and confirmed the app launched successfully.

## User plan
- User is testing overnight tonight.
- Main question: does the app still miss some real snoring events after the new tuning?

## Repo/git context
- Important: `git rev-parse --show-toplevel` resolves to `/Users/gabrielmaldonado`, not the SnoreGuard folder.
- Any git add/commit/push must be tightly scoped to SnoreGuard paths only.
- Remote in use:
  - `origin https://github.com/GabeMaldonado/SnoreAlert.git`

## Recommended next steps after the overnight test
1. Record the test outcome in `PROJECT_STATUS.md`.
2. Compare perceived snore frequency against analytics/event count.
3. If false positives are too high, nudge `snoreConfidenceThreshold` back up before touching UI sensitivity presets.
4. If counts still feel low, do one more round of native ML tuning before revisiting any watch-specific work.
