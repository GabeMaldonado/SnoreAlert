# SnoreGuard ML Model Training Guide

Train a Core ML Sound Classifier that recognizes snoring vs. background noise,
then drop it into the iOS app to replace the dB-threshold detector.

---

## Step 1 — Prepare Training Data

```bash
# Install tools (once)
brew install yt-dlp ffmpeg

# Install Python deps (once)
pip install yt-dlp pydub   # pydub is optional; ffmpeg does the heavy lifting

# Run the prep script
python prepare_training_data.py
```

The script downloads audio from YouTube, slices it into 1-second WAV clips,
and places them in:

```
training_data/
    snore/          ← positive class
    background/     ← negative class (white noise, room ambience)
```

**Tip:** The more diverse your negative class, the fewer false positives you get.
Add clips of:
- Speech / podcasts
- Music
- Coughing / throat-clearing
- Breathing without snoring

You can manually drop extra WAV files into either folder before training.

---

## Step 2 — Train in Create ML

1. Open Xcode → **Open Developer Tool → Create ML**
2. **File → New Document**
3. Choose **Sound Classifier** → Next
4. Name it `SnoreClassifier`, choose a save location → Create
5. In the **Training Data** section, click the **+** and select your
   `training_data/` folder (the one containing `snore/` and `background/`)
6. Click **Train** (takes 1-5 min on Apple Silicon)
7. Check the **Evaluation** tab — aim for >90% accuracy on the test split

### Recommended settings
| Setting | Value |
|---------|-------|
| Algorithm | Transfer Learning |
| Feature Extractor | VGGish |
| Augmentation | On |
| Max Iterations | 25 |

---

## Step 3 — Export the Model

1. When training is done, click the **Output** tab
2. Click **Get** (or drag the model icon) to export `SnoreClassifier.mlmodel`
3. Copy it into the Xcode project:

```bash
cp ~/Downloads/SnoreClassifier.mlmodel \
   ios/SnoreGuard/SnoreClassifier.mlmodel
```

---

## Step 4 — Add the Model to Xcode

1. Open `ios/SnoreGuard.xcworkspace` in Xcode
2. In the Project Navigator, right-click **SnoreGuard** folder → **Add Files**
3. Select `SnoreClassifier.mlmodel`
4. Make sure **Target Membership → SnoreGuard** is checked
5. Xcode auto-compiles it to `SnoreClassifier.mlmodelc` at build time

> The Swift code in `NativeAudioRecorder.swift` looks for `SnoreClassifier.mlmodelc`
> in the main bundle. No other code changes needed.

---

## Step 5 — Build and Test

```bash
# From the SnoreGuard project root
npx expo run:ios --configuration Release --device
```

Watch for this log line confirming ML is active:
```
✅ Core ML snore detection active (threshold: 0.7)
```

If the model file isn't found yet, you'll see:
```
⚠️ SnoreClassifier.mlmodelc not found — using dB threshold only
```
…and the app falls back to the existing dB-threshold behavior automatically.

---

## Confidence Threshold

The classifier fires a snore alert when the model returns a `snore` confidence
≥ **0.70** (70%).

To adjust, change this line in `NativeAudioRecorder.swift`:

```swift
private let snoreConfidenceThreshold: Float = 0.70
```

- **Lower (0.50)** → more sensitive, more false positives
- **Higher (0.85)** → less sensitive, fewer false positives

---

## Iterating on the Model

If you still get false positives (voices triggering snore detection):

1. Record some false-positive audio clips (30-60 seconds of the offending sound)
2. Slice them with ffmpeg: `ffmpeg -i false_positive.m4a -ar 22050 -ac 1 clip_%04d.wav -segment_time 1 -f segment`
3. Drop the clips into `training_data/background/`
4. Re-train in Create ML
5. Export and replace `SnoreClassifier.mlmodel` in the project
