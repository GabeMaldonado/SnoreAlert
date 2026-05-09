#!/usr/bin/env python3
"""
SnoreGuard Training Data Preparation
=====================================
Downloads snore audio from YouTube, slices into 1-second WAV clips,
and organizes into Create ML Sound Classifier training folder structure.

Usage:
    pip install yt-dlp pydub
    python prepare_training_data.py

Output structure:
    training_data/
        snore/           <- positive class (snoring sounds)
            clip_0000.wav
            clip_0001.wav
            ...
        background/      <- negative class (white noise, silence, speech, ambient)
            clip_0000.wav
            ...

After running, open Create ML on your Mac, create a Sound Classifier,
and drag the training_data/ folder into it.
"""

import os
import sys
import subprocess
import shutil
import math

CLIP_DURATION_SECONDS = 1          # Create ML works best with 1-second clips
SAMPLE_RATE = 22050                 # Hz — matches SNClassifySoundRequest default
OUTPUT_DIR = "training_data"
SNORE_DIR = os.path.join(OUTPUT_DIR, "snore")
BG_DIR = os.path.join(OUTPUT_DIR, "background")

# ---------------------------------------------------------------------------
# Source videos — snore audio
# ---------------------------------------------------------------------------
SNORE_SOURCES = [
    {
        "url": "https://www.youtube.com/watch?v=1deTKPX1j8c",
        "label": "snore_main",
    },
    # Add more snore YouTube URLs here if you want more variety, e.g.:
    # {"url": "https://www.youtube.com/watch?v=XXXXXXXXX", "label": "snore_extra"},
]

# ---------------------------------------------------------------------------
# Source videos — background / negative class
# ---------------------------------------------------------------------------
BACKGROUND_SOURCES = [
    {
        "url": "https://www.youtube.com/watch?v=q76bMs-NwRk",  # White noise 10 hours
        "label": "white_noise",
        "max_clips": 200,   # Limit how many clips we take (bg can be very long)
    },
    {
        "url": "https://www.youtube.com/watch?v=nMfPqeZjc2c",  # White noise sleep 2
        "label": "white_noise2",
        "max_clips": 150,
    },
    {
        "url": "https://www.youtube.com/watch?v=ZBIRpOgIylE",  # Sleep breathing (non-snore)
        "label": "sleep_breathing",
        "max_clips": 100,
    },
    {
        "url": "https://www.youtube.com/watch?v=jfKfPfyJRdk",  # Lofi hip hop radio (music)
        "label": "music_lofi",
        "max_clips": 150,
    },
    {
        "url": "https://www.youtube.com/watch?v=5qap5aO4i9A",  # Lofi hip hop - another station
        "label": "music_lofi2",
        "max_clips": 100,
    },
    {
        "url": "https://www.youtube.com/watch?v=n2kh7zRCBWU",  # LibriVox audiobook (speech)
        "label": "speech_audiobook",
        "max_clips": 150,
    },
    {
        "url": "https://www.youtube.com/watch?v=IUN664s7N-c",  # Ambient nature sounds (birds, rain)
        "label": "nature_ambient",
        "max_clips": 100,
    },
]


def check_dependencies():
    """Check that yt-dlp and ffmpeg are installed."""
    missing = []
    for tool in ("yt-dlp", "ffmpeg"):
        if shutil.which(tool) is None:
            missing.append(tool)
    if missing:
        print(f"[ERROR] Missing tools: {', '.join(missing)}")
        print("Install with:")
        print("  brew install yt-dlp ffmpeg")
        sys.exit(1)
    print("[OK] yt-dlp and ffmpeg found")


def download_audio(url: str, output_path: str) -> bool:
    """Download audio from a YouTube URL as a WAV file."""
    print(f"\n[DOWNLOAD] {url}")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--extract-audio",
        "--audio-format", "wav",
        "--audio-quality", "0",
        "--postprocessor-args", f"ffmpeg:-ar {SAMPLE_RATE} -ac 1",
        "--output", output_path,
        "--no-progress",
        url,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[ERROR] yt-dlp failed:\n{result.stderr}")
        return False
    print(f"[OK] Downloaded to {output_path}")
    return True


def get_duration_ffprobe(wav_path: str) -> float:
    """Get audio duration in seconds using ffprobe."""
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        wav_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def slice_audio(input_path: str, output_dir: str, prefix: str, max_clips: int = None):
    """Slice a WAV file into 1-second clips and save to output_dir."""
    os.makedirs(output_dir, exist_ok=True)
    duration = get_duration_ffprobe(input_path)
    total_clips = int(math.floor(duration / CLIP_DURATION_SECONDS))

    if max_clips is not None:
        total_clips = min(total_clips, max_clips)

    print(f"[SLICE] {input_path}: {duration:.1f}s → {total_clips} clips")

    existing = len([f for f in os.listdir(output_dir) if f.endswith(".wav")])
    created = 0

    for i in range(total_clips):
        start = i * CLIP_DURATION_SECONDS
        out_name = f"{prefix}_{i:04d}.wav"
        out_path = os.path.join(output_dir, out_name)

        if os.path.exists(out_path):
            continue  # Skip already-sliced clips

        cmd = [
            "ffmpeg", "-y",
            "-ss", str(start),
            "-t", str(CLIP_DURATION_SECONDS),
            "-i", input_path,
            "-ar", str(SAMPLE_RATE),
            "-ac", "1",
            "-sample_fmt", "s16",
            out_path,
        ]
        subprocess.run(cmd, capture_output=True)
        created += 1

    print(f"[OK] Created {created} new clips ({existing + created} total in {output_dir})")


def process_sources(sources: list, class_dir: str):
    """Download and slice all sources for a given class directory."""
    tmp_dir = "training_data_tmp"
    os.makedirs(tmp_dir, exist_ok=True)

    for source in sources:
        label = source["label"]
        tmp_wav = os.path.join(tmp_dir, f"{label}.wav")

        # Download if not cached
        if not os.path.exists(tmp_wav):
            ok = download_audio(source["url"], tmp_wav)
            if not ok:
                print(f"[WARN] Skipping {label} due to download error")
                continue
        else:
            print(f"[CACHE] Using cached {tmp_wav}")

        max_clips = source.get("max_clips", None)
        slice_audio(tmp_wav, class_dir, label, max_clips=max_clips)


def print_summary():
    """Print final clip counts per class."""
    print("\n" + "=" * 50)
    print("TRAINING DATA SUMMARY")
    print("=" * 50)
    for cls_name, cls_dir in [("snore", SNORE_DIR), ("background", BG_DIR)]:
        if os.path.isdir(cls_dir):
            count = len([f for f in os.listdir(cls_dir) if f.endswith(".wav")])
            print(f"  {cls_name:20s}: {count:5d} clips")
        else:
            print(f"  {cls_name:20s}: (not found)")
    print("=" * 50)
    print(f"\nTraining folder: {os.path.abspath(OUTPUT_DIR)}/")
    print("\nNext steps:")
    print("  1. Open Create ML on your Mac (Xcode → Open Developer Tool → Create ML)")
    print("  2. New Document → Sound Classifier")
    print(f"  3. Drag '{os.path.abspath(OUTPUT_DIR)}/' into the Training Data area")
    print("  4. Click Train")
    print("  5. When done, File → Export Model → SnoreClassifier.mlmodel")
    print(f"  6. Copy SnoreClassifier.mlmodel to ios/SnoreGuard/SnoreClassifier.mlmodel")


def main():
    print("SnoreGuard Training Data Preparation")
    print("=====================================")
    check_dependencies()

    os.makedirs(SNORE_DIR, exist_ok=True)
    os.makedirs(BG_DIR, exist_ok=True)

    print("\n--- Processing SNORE sources ---")
    process_sources(SNORE_SOURCES, SNORE_DIR)

    print("\n--- Processing BACKGROUND sources ---")
    process_sources(BACKGROUND_SOURCES, BG_DIR)

    print_summary()


if __name__ == "__main__":
    main()
