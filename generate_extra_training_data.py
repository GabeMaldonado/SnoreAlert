#!/usr/bin/env python3
"""
Generate extra negative-class training data for SnoreGuard.

Sources:
  speech   — macOS TTS (say command, multiple voices)
  music    — ffmpeg lavfi synthesized harmonic audio
  tv_mix   — ffmpeg mix of music + speech (simulates TV/background)
  nature   — YouTube non-live upload (rain/ambient sounds)

Adds clips to training_data/background/ alongside existing data.
"""

import os
import subprocess
import math
import sys

SR = 22050
CLIP_DUR = 1
BG_DIR = "training_data/background"
TMP_DIR = "training_data_tmp"
CLIP_TARGET = 150  # clips per new category


def check_deps():
    import shutil
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        print(f"[ERROR] Missing: {', '.join(missing)}. Install: brew install ffmpeg")
        sys.exit(1)


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def slice_wav(input_path, prefix, max_clips):
    """Slice a WAV into 1-second clips."""
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", input_path])
    try:
        duration = float(r.stdout.strip())
    except ValueError:
        print(f"[ERROR] Can't determine duration of {input_path}")
        return 0

    n = min(int(math.floor(duration)), max_clips)
    created = 0
    for i in range(n):
        out = os.path.join(BG_DIR, f"{prefix}_{i:04d}.wav")
        if os.path.exists(out):
            continue
        run(["ffmpeg", "-y", "-ss", str(i), "-t", "1",
             "-i", input_path, "-ar", str(SR), "-ac", "1",
             "-sample_fmt", "s16", out])
        created += 1
    print(f"[SLICE] {prefix}: {created} new clips added ({n} total)")
    return created


def generate_speech():
    """Generate speech clips using macOS TTS (say command)."""
    out_wav = os.path.join(TMP_DIR, "speech_tts.wav")
    if os.path.exists(out_wav):
        print(f"[CACHE] {out_wav}")
    else:
        # Multiple voices for variety
        voices = ["Alex", "Daniel", "Karen", "Moira", "Samantha", "Tom"]
        texts = [
            "The quick brown fox jumps over the lazy dog.",
            "In the beginning God created the heavens and the earth.",
            "It was the best of times it was the worst of times.",
            "To be or not to be that is the question.",
            "Four score and seven years ago our fathers brought forth on this continent a new nation.",
            "We the people of the United States in order to form a more perfect union.",
            "Call me Ishmael. Some years ago never mind how long precisely I thought I would sail about.",
            "It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife.",
            "The sun was shining on the sea shining with all his might he did his very best to make the billows smooth and bright.",
            "Once upon a midnight dreary while I pondered weak and weary over many a quaint and curious volume of forgotten lore.",
        ]

        # Generate per-voice segments then concatenate
        segments = []
        for idx, voice in enumerate(voices):
            seg_wav = os.path.join(TMP_DIR, f"speech_{voice.lower()}.wav")
            if not os.path.exists(seg_wav):
                text = " ".join(texts * 5)  # repeat to get ~2 min of speech
                print(f"[TTS] Generating voice: {voice}")
                r = run(["say", "-v", voice, "-o", seg_wav,
                         "--data-format=LEF32@22050", text])
                if r.returncode != 0:
                    print(f"[WARN] Voice {voice} failed, skipping")
                    continue
            segments.append(seg_wav)

        if not segments:
            print("[ERROR] No TTS segments generated")
            return False

        # Concatenate all voice segments
        list_file = os.path.join(TMP_DIR, "speech_list.txt")
        with open(list_file, "w") as f:
            for s in segments:
                f.write(f"file '{os.path.abspath(s)}'\n")

        r = run(["ffmpeg", "-y", "-f", "concat", "-safe", "0",
                 "-i", list_file, "-ar", str(SR), "-ac", "1",
                 "-sample_fmt", "s16", out_wav])
        if r.returncode != 0:
            print(f"[ERROR] Concat failed: {r.stderr[:200]}")
            return False
        print(f"[OK] Speech WAV generated: {out_wav}")

    return slice_wav(out_wav, "speech_tts", CLIP_TARGET)


def generate_music():
    """Generate music-like audio using ffmpeg lavfi harmonic synthesis."""
    out_wav = os.path.join(TMP_DIR, "music_synth.wav")
    if os.path.exists(out_wav):
        print(f"[CACHE] {out_wav}")
    else:
        # Mix of harmonic tones at musical intervals (C major chord + bass + melody)
        # Creates complex audio with musical frequency content
        DURATION = 200  # seconds — enough for 150+ clips
        expr = (
            "0.20*sin(2*PI*130.81*t)"   # C2 bass
            "+0.15*sin(2*PI*261.63*t)"  # C4
            "+0.12*sin(2*PI*329.63*t)"  # E4
            "+0.10*sin(2*PI*392.00*t)"  # G4
            "+0.08*sin(2*PI*523.25*t)"  # C5
            "+0.06*sin(2*PI*659.26*t)"  # E5
            # Add slow amplitude modulation (tremolo) to simulate musical rhythm
            "*( 0.7 + 0.3*sin(2*PI*1.33*t) )"
            # Add a melodic component that changes note
            "+0.10*sin(2*PI*(440+50*sin(2*PI*0.1*t))*t)"
        )
        print("[SYNTH] Generating music-like harmonic audio...")
        r = run([
            "ffmpeg", "-y",
            "-f", "lavfi",
            "-i", f"aevalsrc='{expr}':s={SR}:d={DURATION}",
            "-ar", str(SR), "-ac", "1", "-sample_fmt", "s16",
            out_wav
        ])
        if r.returncode != 0:
            print(f"[ERROR] ffmpeg synth failed: {r.stderr[:300]}")
            return False
        print(f"[OK] Music WAV generated: {out_wav}")

    return slice_wav(out_wav, "music_synth", CLIP_TARGET)


def generate_tv_mix():
    """Generate a speech + music mix to simulate TV/podcast audio."""
    out_wav = os.path.join(TMP_DIR, "tv_mix.wav")
    speech_wav = os.path.join(TMP_DIR, "speech_tts.wav")
    music_wav = os.path.join(TMP_DIR, "music_synth.wav")

    if not os.path.exists(speech_wav) or not os.path.exists(music_wav):
        print("[SKIP] tv_mix: speech or music WAV not yet generated")
        return 0

    if os.path.exists(out_wav):
        print(f"[CACHE] {out_wav}")
    else:
        print("[MIX] Generating TV mix (speech + music)...")
        DURATION = 100
        r = run([
            "ffmpeg", "-y",
            "-i", speech_wav,
            "-i", music_wav,
            "-filter_complex",
            f"[0:a]atrim=0:{DURATION},asetpts=PTS-STARTPTS,volume=1.0[a];"
            f"[1:a]atrim=0:{DURATION},asetpts=PTS-STARTPTS,volume=0.4[b];"
            "[a][b]amix=inputs=2:duration=shortest[out]",
            "-map", "[out]",
            "-ar", str(SR), "-ac", "1", "-sample_fmt", "s16",
            out_wav
        ])
        if r.returncode != 0:
            print(f"[ERROR] Mix failed: {r.stderr[:300]}")
            return 0
        print(f"[OK] TV mix WAV generated: {out_wav}")

    return slice_wav(out_wav, "tv_mix", 100)


def download_nature():
    """Download a non-live nature/rain sounds video from YouTube."""
    import shutil
    if shutil.which("yt-dlp") is None:
        print("[SKIP] yt-dlp not found, skipping nature download")
        return 0

    out_wav = os.path.join(TMP_DIR, "nature_rain.wav")
    if os.path.exists(out_wav):
        print(f"[CACHE] {out_wav}")
    else:
        # Non-live rain sounds video (regular upload, not live stream)
        # This is a ~3hr rain video — we cap download to first 3 minutes via --download-sections
        URLS = [
            ("https://www.youtube.com/watch?v=q76bMs-NwRk", "white_noise_alt"),  # already have raw, reuse
            ("https://www.youtube.com/watch?v=lFcSrYw-ARY", "nature_rain1"),    # Rain on window
            ("https://www.youtube.com/watch?v=mPZkdNFkNps", "nature_rain2"),    # Heavy rain
        ]

        downloaded = False
        for url, label in URLS:
            candidate = os.path.join(TMP_DIR, f"{label}.wav")
            if os.path.exists(candidate):
                # Reuse an already-downloaded file
                import shutil as sh
                sh.copy(candidate, out_wav)
                downloaded = True
                print(f"[CACHE] Reusing {candidate}")
                break

            print(f"[DOWNLOAD] Trying nature URL: {url}")
            r = run([
                "yt-dlp",
                "--no-playlist",
                "--extract-audio",
                "--audio-format", "wav",
                "--audio-quality", "0",
                "--postprocessor-args", f"ffmpeg:-ar {SR} -ac 1",
                "--download-sections", "*00:00:00-00:05:00",  # Only first 5 minutes
                "--no-live-from-start",
                "--output", out_wav,
                "--no-progress",
                url,
            ])
            if r.returncode == 0 and os.path.exists(out_wav):
                downloaded = True
                print(f"[OK] Nature downloaded")
                break
            else:
                print(f"[WARN] {url} failed: {r.stderr[:100]}")

        if not downloaded:
            print("[SKIP] Could not download nature sounds — skipping category")
            return 0

    return slice_wav(out_wav, "nature_rain", 100)


def print_summary():
    if not os.path.isdir(BG_DIR):
        return
    count = len([f for f in os.listdir(BG_DIR) if f.endswith(".wav")])
    snore_dir = "training_data/snore"
    snore_count = 0
    if os.path.isdir(snore_dir):
        snore_count = len([f for f in os.listdir(snore_dir) if f.endswith(".wav")])

    print("\n" + "=" * 50)
    print("TRAINING DATA SUMMARY")
    print("=" * 50)
    print(f"  snore      : {snore_count:5d} clips")
    print(f"  background : {count:5d} clips")
    print("=" * 50)

    # Show per-prefix counts
    from collections import Counter
    prefixes = Counter()
    for f in os.listdir(BG_DIR):
        if f.endswith(".wav"):
            prefix = "_".join(f.split("_")[:-1])  # strip _NNNN
            prefixes[prefix] += 1
    for p, n in sorted(prefixes.items()):
        print(f"    {p:30s}: {n}")
    print()
    print("Next: Open Create ML → Sound Classifier → drag training_data/ → Train")
    print("Then export SnoreClassifier.mlmodel → copy to ios/SnoreGuard/")


def main():
    print("SnoreGuard Extra Training Data Generator")
    print("=========================================")
    check_deps()
    os.makedirs(BG_DIR, exist_ok=True)
    os.makedirs(TMP_DIR, exist_ok=True)

    print("\n--- Generating SPEECH clips (macOS TTS) ---")
    generate_speech()

    print("\n--- Generating MUSIC clips (ffmpeg synthesis) ---")
    generate_music()

    print("\n--- Generating TV-MIX clips (speech + music) ---")
    generate_tv_mix()

    print("\n--- Downloading NATURE clips (YouTube) ---")
    download_nature()

    print_summary()


if __name__ == "__main__":
    main()
