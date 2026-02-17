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
    logger.info("🎤 START called - Beginning native audio recording setup")

    do {
      logger.info("🎤 Configuring audio session...")
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .default)
      logger.info("🎤 Audio session category set to .record")

      try audioSession.setActive(true)
      logger.info("🎤 Audio session activated successfully")

      let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44100.0,
        AVNumberOfChannelsKey: 2,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
      ]

      let fileURL = FileManager.default.temporaryDirectory.appendingPathComponent("recording.m4a")
      logger.info("🎤 Creating audio recorder with file: \(fileURL.path)")

      audioRecorder = try AVAudioRecorder(url: fileURL, settings: settings)
      audioRecorder?.delegate = self
      audioRecorder?.isMeteringEnabled = true
      let meteringEnabled = audioRecorder?.isMeteringEnabled ?? false
      logger.info("🎤 Audio recorder created, metering enabled: \(meteringEnabled)")

      if audioRecorder?.record() == true {
        let isRecording = audioRecorder?.isRecording ?? false
        logger.info("🎤 ✅ Recording started successfully! isRecording: \(isRecording)")

        // Start level monitoring
        levelTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
          self?.updateMetering()
        }
        logger.info("🎤 Level timer created and scheduled")

        resolve(true)
        logger.info("🎤 START completed - resolved promise with true")
      } else {
        logger.error("🎤 ❌ Failed to start native audio recording - record() returned false")
        reject("RECORD_ERROR", "Failed to start recording", nil)
      }
    } catch {
      logger.error("🎤 ❌ Audio recording error: \(error.localizedDescription)")
      reject("RECORD_ERROR", error.localizedDescription, error)
    }
  }

  @objc
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    logger.info("🛑 STOP called")

    if let timer = levelTimer {
      logger.info("🛑 Invalidating level timer")
      timer.invalidate()
      levelTimer = nil
    } else {
      logger.warning("🛑 No level timer to invalidate")
    }

    if let recorder = audioRecorder {
      logger.info("🛑 Stopping audio recorder, was recording: \(recorder.isRecording)")
      recorder.stop()
      audioRecorder = nil
    } else {
      logger.warning("🛑 No audio recorder to stop")
    }

    logger.info("🛑 Native audio recording stopped")
    resolve(true)
  }

  private func updateMetering() {
    guard let recorder = audioRecorder else {
      logger.warning("📊 updateMetering called but audioRecorder is nil")
      return
    }

    guard recorder.isRecording else {
      logger.warning("📊 updateMetering called but recorder is not recording")
      return
    }

    recorder.updateMeters()
    let averagePower = recorder.averagePower(forChannel: 0)
    logger.info("📊 Metering updated: \(averagePower) dB")

    sendEvent(withName: "NativeAudioLevel", body: ["level": averagePower])
    logger.info("📊 Sent NativeAudioLevel event with level: \(averagePower)")
  }

  // AVAudioRecorderDelegate
  func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    if let error = error {
      logger.error("❌ Audio recorder encode error: \(error.localizedDescription)")
      sendEvent(withName: "NativeAudioError", body: ["message": error.localizedDescription])
    }
  }

  func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    logger.info("🎤 Audio recorder finished recording, success: \(flag)")
  }
}
