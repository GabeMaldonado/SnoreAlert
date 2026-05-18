#!/usr/bin/env python3
"""
extract_training_clips.py — Pull labeled training clips from an overnight recording.

Reads the 48 kHz 16-bit WAV produced from the CAF, finds segments that are
significantly louder than ambient (potential snoring / interesting sounds), and
exports 2-second clips into a Create ML-ready folder structure:

    CreateML_Training/
        Snore/      ← loud / interesting segments  (review + remove false positives)
        Background/ ← quiet segments               (ambient / silence)

Then rename / delete clips as needed before feeding to Create ML.

Usage:
    python3 extract_training_clips.py <input.wav> [options]

Options:
    --out DIR          Output directory (default: ./CreateML_Training)
    --clip-sec FLOAT   Clip length in seconds (default: 2.0)
    --threshold DB     Segments above this RMS-dB are "loud" (default: auto-detect)
    --min-gap-sec SEC  Min silence gap to end a loud segment (default: 0.5)
    --max-clips INT    Max clips to export per class (default: 500)
    --target-sr INT    Target sample rate for exported clips (default: 16000)
"""

import os
import sys
import wave
import struct
import argparse
import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile as scipy_wavfile
from scipy.signal import resample_poly
from math import gcd


def rms_db_arr(arr: np.ndarray) -> float:
    """RMS of float32 audio in dBFS."""
    rms = float(np.sqrt(np.mean(arr.astype(np.float64) ** 2)))
    return 20.0 * math.log10(max(rms, 1e-9))


def resample_arr(arr: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return arr
    g = gcd(dst_sr, src_sr)
    up, down = dst_sr // g, src_sr // g
    return resample_poly(arr.astype(np.float64), up, down)


def write_wav(path: Path, arr: np.ndarray, sample_rate: int):
    out = np.clip(arr, -1.0, 1.0)
    scipy_wavfile.write(str(path), sample_rate, (out * 32767).astype(np.int16))


def auto_threshold(window_dbs: np.ndarray) -> float:
    """12 dB above the 20th-percentile quiet floor."""
    p20 = float(np.percentile(window_dbs, 20))
    threshold = p20 + 12.0
    print(f"  Ambient floor (p20): {p20:.1f} dB  →  loud threshold: {threshold:.1f} dB")
    return threshold


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="WAV or CAF recording (any sample rate / bit depth)")
    parser.add_argument("--out", default=str(Path(__file__).parent / "training_data"))
    parser.add_argument("--clip-sec", type=float, default=2.0)
    parser.add_argument("--threshold", type=float, default=None,
                        help="RMS-dB above which a window is 'loud' (default: auto)")
    parser.add_argument("--min-gap-sec", type=float, default=0.5)
    parser.add_argument("--max-clips", type=int, default=500)
    parser.add_argument("--target-sr", type=int, default=16000)
    args = parser.parse_args()

    in_path = Path(args.input)
    if not in_path.exists():
        sys.exit(f"[ERROR] File not found: {in_path}")

    out_dir = Path(args.out)
    snore_dir = out_dir / "snore"
    bg_dir = out_dir / "background"
    snore_dir.mkdir(parents=True, exist_ok=True)
    bg_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {in_path.name} …")
    src_sr, data = scipy_wavfile.read(str(in_path))

    # Normalise to float32 in [-1, 1]
    if data.dtype == np.int16:
        audio = data.astype(np.float32) / 32768.0
    elif data.dtype == np.int32:
        audio = data.astype(np.float32) / 2147483648.0
    elif data.dtype == np.float32:
        audio = data
    else:
        audio = data.astype(np.float32)

    # Mix down to mono if needed
    if audio.ndim > 1:
        audio = audio[:, 0]

    n_frames = len(audio)
    duration_sec = n_frames / src_sr
    print(f"  Sample rate : {src_sr} Hz")
    print(f"  Duration    : {duration_sec / 3600:.2f} h  ({duration_sec:.0f} s)")
    print(f"  Samples     : {n_frames:,}")

    # ── Pass 1: per-0.5s RMS energy ──────────────────────────────────────────
    win = int(src_sr * 0.5)
    n_wins = n_frames // win
    print(f"\nPass 1: computing energy for {n_wins:,} windows …")

    window_dbs = np.empty(n_wins, dtype=np.float32)
    for i in range(n_wins):
        chunk = audio[i * win:(i + 1) * win]
        window_dbs[i] = rms_db_arr(chunk)
        if i % 5000 == 0:
            print(f"  … {i / n_wins * 100:.0f}%", end='\r')
    print(f"  Done.  min={window_dbs.min():.1f} dB  median={np.median(window_dbs):.1f} dB  max={window_dbs.max():.1f} dB")

    threshold = args.threshold if args.threshold is not None else auto_threshold(window_dbs)

    # ── Pass 2: segment detection ─────────────────────────────────────────────
    loud_mask = window_dbs >= threshold
    min_gap = max(1, int(args.min_gap_sec / 0.5))

    loud_segments, bg_windows = [], []
    i = 0
    while i < n_wins:
        if loud_mask[i]:
            start = i
            gap = 0
            j = i + 1
            while j < n_wins:
                if loud_mask[j]:
                    gap = 0
                else:
                    gap += 1
                    if gap > min_gap:
                        break
                j += 1
            end = j - gap
            loud_segments.append((start, end))
            i = j
        else:
            bg_windows.append(i)
            i += 1

    loud_secs = sum(e - s for s, e in loud_segments) * 0.5
    print(f"\nFound {len(loud_segments):,} loud segments ({loud_secs:.0f} s total)")
    print(f"Found {len(bg_windows):,} quiet windows ({len(bg_windows) * 0.5:.0f} s total)")

    # ── Pass 3: export clips ──────────────────────────────────────────────────
    clip_frames_src = int(src_sr * args.clip_sec)
    print(f"\nExporting clips (max {args.max_clips} per class, target {args.target_sr} Hz) …")

    step = max(1, len(loud_segments) // args.max_clips)
    selected_loud = loud_segments[::step][:args.max_clips]

    bg_step = max(1, len(bg_windows) // args.max_clips)
    selected_bg = bg_windows[::bg_step][:args.max_clips]

    snore_count = 0
    for idx, (s_win, e_win) in enumerate(selected_loud):
        frame_s = s_win * win
        seg_len = (e_win - s_win) * win
        mid = frame_s + seg_len // 2
        clip_start = max(0, mid - clip_frames_src // 2)
        clip_end = min(n_frames, clip_start + clip_frames_src)
        chunk = audio[clip_start:clip_end]
        out = resample_arr(chunk, src_sr, args.target_sr)
        write_wav(snore_dir / f"snore_{snore_count:04d}.wav", out, args.target_sr)
        snore_count += 1
        if idx % 50 == 0:
            print(f"  Snore: {snore_count}", end='\r')

    bg_count = 0
    for idx, w in enumerate(selected_bg):
        frame_s = w * win
        clip_end = min(n_frames, frame_s + clip_frames_src)
        chunk = audio[frame_s:clip_end]
        out = resample_arr(chunk, src_sr, args.target_sr)
        write_wav(bg_dir / f"background_{bg_count:04d}.wav", out, args.target_sr)
        bg_count += 1
        if idx % 50 == 0:
            print(f"  Background: {bg_count}", end='\r')

    print(f"\n\nDone!")
    print(f"  Snore clips      : {snore_count:,}  →  {snore_dir}")
    print(f"  Background clips : {bg_count:,}  →  {bg_dir}")
    print(f"\nNext steps:")
    print(f"  1. Listen to a sample from Snore/ — delete any that are NOT snoring")
    print(f"  2. Listen to a sample from Background/ — delete any that ARE snoring")
    print(f"  3. Drag both folders into Create ML → Sound Classifier → train")


if __name__ == "__main__":
    main()
