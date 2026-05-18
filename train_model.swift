#!/usr/bin/env swift
// train_model.swift — Train the SnoreAlert Sound Classifier via CreateML.
//
// Usage:
//   swift train_model.swift
//
// Reads training data from:   training_data/{snore,background}/
// Writes trained model to:    MySoundClassifier.mlproj/Models/SnoreClassifier.mlmodel
//
// The model can then be deployed with:
//   python3 deploy_model.py

import Foundation
import CreateML

// ── Paths ─────────────────────────────────────────────────────────────────────
let scriptDir = URL(fileURLWithPath: #file).deletingLastPathComponent()
let trainingDataDir = scriptDir.appendingPathComponent("training_data")
let outputDir = scriptDir
    .appendingPathComponent("MySoundClassifier.mlproj")
    .appendingPathComponent("Models")
let outputModelURL = outputDir.appendingPathComponent("SnoreClassifier.mlmodel")

// ── Sanity check ──────────────────────────────────────────────────────────────
let fm = FileManager.default

func countFiles(in url: URL) -> Int {
    (try? fm.contentsOfDirectory(atPath: url.path))?.filter { $0.hasSuffix(".wav") }.count ?? 0
}

let snoreDir  = trainingDataDir.appendingPathComponent("snore")
let bgDir     = trainingDataDir.appendingPathComponent("background")
let snoreCount = countFiles(in: snoreDir)
let bgCount    = countFiles(in: bgDir)

print("SnoreAlert Model Trainer")
print("========================")
print("Training data:")
print("  snore/      \(snoreCount) clips")
print("  background/ \(bgCount) clips")
print("")

guard snoreCount > 0 && bgCount > 0 else {
    print("[ERROR] Missing training data. Expected clips in training_data/snore/ and training_data/background/")
    exit(1)
}

try fm.createDirectory(at: outputDir, withIntermediateDirectories: true)

// ── Train ─────────────────────────────────────────────────────────────────────
print("[TRAIN] Starting Sound Classifier training…")

let params = MLSoundClassifier.ModelParameters(
    validation: .split(strategy: .automatic),
    maxIterations: 25,
    overlapFactor: 0.5
)

let startTime = Date()
let classifier = try MLSoundClassifier(
    trainingData: .labeledDirectories(at: trainingDataDir),
    parameters: params
)
let elapsed = Date().timeIntervalSince(startTime)
print(String(format: "[TRAIN] Completed in %.1f s", elapsed))

// ── Metrics ───────────────────────────────────────────────────────────────────
let trainAcc  = classifier.trainingMetrics.classificationError
let validAcc  = classifier.validationMetrics.classificationError

print("")
print("Results:")
print(String(format: "  Training error   : %.1f%%", trainAcc  * 100))
print(String(format: "  Validation error : %.1f%%", validAcc  * 100))
print(String(format: "  Training accuracy: %.1f%%", (1 - trainAcc)  * 100))
print(String(format: "  Validation accuracy: %.1f%%", (1 - validAcc) * 100))

// ── Save ──────────────────────────────────────────────────────────────────────
let meta = MLModelMetadata(
    author: "SnoreAlert",
    shortDescription: "Snore vs background sound classifier — \(snoreCount) snore + \(bgCount) background clips",
    version: "2.0"
)

// Remove old model if present so we get a clean write
if fm.fileExists(atPath: outputModelURL.path) {
    try fm.removeItem(at: outputModelURL)
}

try classifier.write(to: outputModelURL, metadata: meta)
print("")
print("[SAVE] Model written to: \(outputModelURL.path)")

let attrs = try fm.attributesOfItem(atPath: outputModelURL.path)
let size = (attrs[.size] as? Int ?? 0)
print(String(format: "       Size: %.1f KB", Double(size) / 1024.0))
print("")
print("Next step: run  python3 deploy_model.py  to build and install on iPhone.")
