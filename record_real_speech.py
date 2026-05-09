#!/usr/bin/env python3
"""
Record real speech and ambient sound samples for SnoreGuard training data.

Guides you through 4 recording sessions, then slices everything into
1-second WAV clips and adds them to training_data/background/.

Usage:
    python3 record_real_speech.py

Requirements: ffmpeg (brew install ffmpeg)
"""

import os
import sys
import subprocess
import math
import shutil
import time

SR = 22050
CLIP_DUR = 1
BG_DIR = "training_data/background"
TMP_DIR = "training_data_tmp"
MIC_DEVICE = "0"  # iMac Microphone [0]

SESSIONS = [
    {
        "label": "real_speech_conv",
        "duration": 120,
        "prompt": (
            "CONVERSATION SPEECH (2 min)\n"
            "Talk naturally — describe your day, read text aloud, have a conversation.\n"
            "Vary your pace, volume, and tone. Pauses are fine."
        ),
    },
    {
        "label": "real_speech_quiet",
        "duration": 60,
        "prompt": (
            "QUIET SPEECH (1 min)\n"
            "Speak softly, like you're talking in a bedroom at night.\n"
            "Whisper-level to low conversational volume."
        ),
    },
    {
        "label": "real_ambient_room",
        "duration": 60,
        "prompt": (
            "ROOM AMBIENCE (1 min)\n"
            "Stay quiet — let the mic pick up natural room noise:\n"
            "AC hum, distant traffic, house sounds. Don't speak."
        ),
    },
    {
        "label": "real_tv_bg",
        "duration": 90,
        "prompt": (
            "BACKGROUND TV/MUSIC (1.5 min)\n"
            "Play a TV show or music at typical bedroom volume.\n"
            "You can also talk over it. Simulate real bedroom background noise."
        ),
    },
]


def run(cmd, **kwargs):
    return subprocess.run(cmd, **kwargs)


def check_deps():
    if shutil.which("ffmpeg") is None:
        print("[ERROR] ffmpeg not found. Install: brew install ffmpeg")
        sys.exit(1)


def record_session(label, duration, prompt):
    out_wav = os.path.join(TMP_DIR, f"{label}.wav")
    if os.path.exists(out_wav):
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", out_wav],
            capture_output=True, text=True
        )
        try:
            existing_dur = float(r.stdout.strip())
            print(f"[CACHE] {label} already recorded ({existing_dur:.0f}s) — skipping")
            return True
        except ValueError:
            pass

    print(f"\n{'='*60}")
    print(prompt)
    print(f"{'='*60}")
    print(f"\nRecording for {duration} seconds...")
    print("Press ENTER to start, then speak/make sounds as described.")
    input()
    print(f"[REC] Recording... ({duration}s)")

    result = run([
        "ffmpeg", "-y",
        "-f", "avfoundation",
        "-i", f":{MIC_DEVICE}",
        "-t", str(duration),
        "-ar", str(SR),
        "-ac", "1",
        "-sample_fmt", "s16",
        out_wav
    ], capture_output=True)

    if result.returncode != 0 or not os.path.exists(out_wav):
        print(f"[ERROR] Recording failed: {result.stderr[-300:]}")
        return False

    print(f"[OK] Recorded: {out_wav}")
    return True


def slice_to_background(label):
    in_wav = os.path.join(TMP_DIR, f"{label}.wav")
    if not os.path.exists(in_wav):
        print(f"[SKIP] {in_wav} not found")
        return 0

    # Get duration
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", in_wav],
        capture_output=True, text=True
    )
    try:
        duration = float(r.stdout.strip())
    except ValueError:
        print(f"[ERROR] Can't determine duration of {in_wav}")
        return 0

    n_clips = int(math.floor(duration))
    created = 0
    skipped = 0

    for i in range(n_clips):
        out_path = os.path.join(BG_DIR, f"{label}_{i:04d}.wav")
        if os.path.exists(out_path):
            skipped += 1
            continue
        subprocess.run([
            "ffmpeg", "-y",
            "-ss", str(i), "-t", "1",
            "-i", in_wav,
            "-ar", str(SR), "-ac", "1", "-sample_fmt", "s16",
            out_path
        ], capture_output=True)
        created += 1

    print(f"[SLICE] {label}: {created} new clips ({skipped} already existed, {n_clips} total)")
    return created


def print_summary():
    from collections import Counter
    print("\n" + "=" * 60)
    print("TRAINING DATA SUMMARY")
    print("=" * 60)

    snore_count = len([f for f in os.listdir("training_data/snore") if f.endswith(".wav")])
    bg_count = len([f for f in os.listdir(BG_DIR) if f.endswith(".wav")])
    print(f"  snore      : {snore_count:5d} clips")
    print(f"  background : {bg_count:5d} clips")
    print("=" * 60)

    prefixes = Counter()
    for f in os.listdir(BG_DIR):
        if f.endswith(".wav"):
            prefix = "_".join(f.split("_")[:-1])
            prefixes[prefix] += 1
    for p, n in sorted(prefixes.items()):
        print(f"    {p:35s}: {n}")

    print()
    print("NEXT STEPS:")
    print("  1. Open MySoundClassifier.mlproj in Create ML")
    print("  2. The project already has your training_data/ linked")
    print("     If it shows stale data: remove + re-add training_data/ folder")
    print("  3. Click Train — it should converge quickly")
    print("  4. File → Save (model auto-saves inside the .mlproj bundle)")
    print("  5. Run: python3 deploy_model.py")
    print()


def main():
    print("SnoreGuard Real Speech Recorder")
    print("================================")
    print("This will record 4 audio sessions (~5.5 min total) and add")
    print("them to training_data/background/ as real speech samples.")
    print()
    check_deps()
    os.makedirs(BG_DIR, exist_ok=True)
    os.makedirs(TMP_DIR, exist_ok=True)

    total_new = 0
    for session in SESSIONS:
        ok = record_session(session["label"], session["duration"], session["prompt"])
        if ok:
            total_new += slice_to_background(session["label"])

    print(f"\n[DONE] Added {total_new} new background clips from real recordings.")
    print_summary()


if __name__ == "__main__":
    main()
