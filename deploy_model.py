#!/usr/bin/env python3
"""
Deploy the latest trained SnoreClassifier model to the iOS project,
then build and install on the connected iPhone.

Usage:
    python3 deploy_model.py
"""

import os
import sys
import glob
import shutil
import subprocess

MLPROJ_DIR = "MySoundClassifier.mlproj"
IOS_MODEL_DEST = "ios/SnoreGuard/SnoreClassifier.mlmodel"
DEVICE_ID = "99C20B85-2B42-51CD-9767-6B0CE17A0491"
TEAM_ID = "TDSR3ULM7K"
APP_BUNDLE = "com.agenticdevlabs.snoreguard"
BUILD_DIR = "ios/build"


def run(cmd, check=True, **kwargs):
    print(f"  $ {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if check and result.returncode != 0:
        print(f"[ERROR] Command failed:\n{result.stderr[-500:]}")
        sys.exit(1)
    return result


def find_latest_model():
    """Find the most recently modified .mlmodel inside the .mlproj bundle."""
    pattern = os.path.join(MLPROJ_DIR, "**", "*.mlmodel")
    models = glob.glob(pattern, recursive=True)
    if not models:
        print(f"[ERROR] No .mlmodel found inside {MLPROJ_DIR}")
        print("  Make sure you've trained the model in Create ML first.")
        sys.exit(1)
    # Pick the most recently modified
    latest = max(models, key=os.path.getmtime)
    return latest


def main():
    print("SnoreGuard Model Deployer")
    print("=========================")

    # 1. Find model
    model_path = find_latest_model()
    mtime = os.path.getmtime(model_path)
    import datetime
    mtime_str = datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n[MODEL] Found: {model_path}")
    print(f"        Modified: {mtime_str}")
    print(f"        Size: {os.path.getsize(model_path):,} bytes")

    # 2. Copy to ios/
    print(f"\n[COPY] {model_path} → {IOS_MODEL_DEST}")
    shutil.copy2(model_path, IOS_MODEL_DEST)
    print(f"[OK] Copied")

    # 3. Build
    print(f"\n[BUILD] Building Release for device...")
    run([
        "xcodebuild", "build",
        "-workspace", "ios/SnoreGuard.xcworkspace",
        "-scheme", "SnoreGuard",
        "-configuration", "Release",
        "-sdk", "iphoneos",
        "-derivedDataPath", BUILD_DIR,
        "-allowProvisioningUpdates",
        "CODE_SIGN_STYLE=Automatic",
        f"DEVELOPMENT_TEAM={TEAM_ID}",
    ])
    print("[OK] Build succeeded")

    # 4. Install
    app_path = os.path.join(BUILD_DIR, "Build/Products/Release-iphoneos/SnoreGuard.app")
    if not os.path.isdir(app_path):
        print(f"[ERROR] App not found at {app_path}")
        sys.exit(1)

    print(f"\n[INSTALL] Installing on device {DEVICE_ID}...")
    run(["xcrun", "devicectl", "device", "install", "app",
         "--device", DEVICE_ID, app_path])
    print("[OK] Installed")

    # 5. Launch
    print(f"\n[LAUNCH] Launching {APP_BUNDLE}...")
    run(["xcrun", "devicectl", "device", "process", "launch",
         "--device", DEVICE_ID, APP_BUNDLE])
    print("[OK] Launched")

    print("\n✅ Done! SnoreGuard is running with the new model.")


if __name__ == "__main__":
    main()
