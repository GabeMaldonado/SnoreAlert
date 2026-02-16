import Foundation
import AVFoundation
import os

@objc(NativeAudioRecorder)
class NativeAudioRecorder: RCTEventEmitter, AVAudioRecorderDelegate {

  private var audioRecorder: AVAudioRecorder?
  private var levelTimer: Timer?
  private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "NativeAudioRecorder")

  override init() {
    super.init()
  }

  @objc
  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  @objc
  override func supportedEvents() -> [String] {
    return ["NativeAudioLevel", "NativeAudioError"]
  }

  @objc
  func start(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .default)
      try audioSession.setActive(true)

      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44100.0,
        AVNumberOfChannelsKey: 2,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
      ]

      let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("recording.m4a")
      audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
      audioRecorder?.delegate = self
      audioRecorder?.isMeteringEnabled = true

      if audioRecorder?.record() == true {
        logger.info("Native audio recording started")

        // Start level monitoring
        levelTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
          self?.updateMetering()
        }

        resolve(true)
      } else {
        logger.error("Failed to start native audio recording")
        reject("RECORD_ERROR", "Failed to start recording", nil)
      }
    } catch {
      logger.error("Audio recording error: \(error.localizedDescription)")
      reject("RECORD_ERROR", error.localizedDescription, error)
    }
  }

  @objc
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    levelTimer?.invalidate()
    levelTimer = nil

    audioRecorder?.stop()
    audioRecorder = nil

    logger.info("Native audio recording stopped")
    resolve(true)
  }

  private func updateMetering() {
    guard let recorder = audioRecorder else { return }

    recorder.updateMeters()
    let averagePower = recorder.averagePower(forChannel: 0)

    sendEvent(withName: "NativeAudioLevel", body: ["level": averagePower])
  }

  // AVAudioRecorderDelegate
  func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    if let error = error {
      logger.error("Audio recorder error: \(error.localizedDescription)")
      sendEvent(withName: "NativeAudioError", body: ["message": error.localizedDescription])
    }
  }
}
