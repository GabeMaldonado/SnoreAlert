import Foundation
import AVFoundation
import SoundAnalysis
import os

@objc(NativeAudioRecorder)
class NativeAudioRecorder: RCTEventEmitter {

  // MARK: - Properties

  private var audioEngine: AVAudioEngine?
  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "NativeAudioRecorder")

  // Training audio capture
  private let recordingQueue = DispatchQueue(label: "com.snoreguard.trainingRecording", qos: .utility)
  private var isTrainingRecordingEnabled = false
  private var trainingAudioFile: AVAudioFile?
  private var trainingConverter: AVAudioConverter?
  // currentTrainingRecordingURL and lastTrainingRecordingURL are only
  // read/written on recordingQueue to avoid cross-thread races.
  private var currentTrainingRecordingURL: URL?
  private var lastTrainingRecordingURL: URL?

  // Metering — written on the AVAudioEngine render thread, read on meteringQueue.
  // On arm64 aligned Float reads/writes are naturally atomic; a torn read
  // produces a momentarily stale dB value which is acceptable for a UI meter.
  private var meteringTimer: DispatchSourceTimer?
  private let meteringQueue = DispatchQueue(label: "com.snoreguard.metering", qos: .background)
  private var currentPower: Float = -160.0

  // Sound Analysis (Core ML)
  private var streamAnalyzer: SNAudioStreamAnalyzer?
  private var analysisObserver: SnoreAnalysisObserver?
  private let analysisQueue = DispatchQueue(label: "com.snoreguard.analysis", qos: .background)
  private var useMLDetection = false
  private let snoreConfidenceThreshold: Float = 0.85
  // Skip ML inference for near-silence. Overnight audio from a nightstand ~-60 dBFS.
  private let mlMinimumPowerThreshold: Float = -62.0
  // Monotonically increasing frame counter for SNAudioStreamAnalyzer.
  // Only written/read on the AVAudioEngine render thread — no lock needed.
  private var currentFramePosition: AVAudioFramePosition = 0
  // Set true by start(), false by stop() — used by rebuildAndRestartEngine to distinguish
  // a user-initiated stop from a media-services reset that temporarily nils the engine.
  private var isSessionActive = false

  // MARK: - RCTEventEmitter

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

  // MARK: - Start

  @objc
  func start(_ options: NSDictionary?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    logger.info("🎤 START called")

    do {
      if let saveTrainingRecording = options?["saveTrainingRecording"] as? Bool {
        isTrainingRecordingEnabled = saveTrainingRecording
      }

      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
      try session.setActive(true)
      logger.info("🎤 Audio session activated")

      let engine = AVAudioEngine()
      audioEngine = engine

      let inputNode = engine.inputNode
      let inputFormat = inputNode.outputFormat(forBus: 0)

      setupMLAnalysis(format: inputFormat)
      recordingQueue.sync { setupTrainingRecordingIfNeeded(format: inputFormat) }

      inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
        guard let self = self else { return }
        self.processTapBuffer(buffer)
      }

      try engine.start()
      isSessionActive = true
      setupAudioSessionObservers()
      startMeteringTimer()
      logger.info("🎤 ✅ AVAudioEngine started")
      resolve(true)

    } catch {
      logger.error("🎤 ❌ Error: \(error.localizedDescription)")
      reject("RECORD_ERROR", error.localizedDescription, error)
    }
  }

  // MARK: - Stop

  @objc
  func stop(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    logger.info("🛑 STOP called")
    isSessionActive = false
    removeAudioSessionObservers()
    stopMeteringTimer()
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    audioEngine = nil
    streamAnalyzer = nil
    analysisObserver = nil
    currentFramePosition = 0
    currentPower = -160.0

    var recordingPath: String?
    recordingQueue.sync {
      recordingPath = self.currentTrainingRecordingURL?.path
      self.trainingAudioFile = nil
      self.trainingConverter = nil
      self.lastTrainingRecordingURL = self.currentTrainingRecordingURL
      self.currentTrainingRecordingURL = nil
    }

    logger.info("🛑 Stopped")
    resolve([
      "stopped": true,
      "trainingRecordingPath": recordingPath as Any
    ])
  }

  @objc
  func setTrainingRecordingEnabled(_ enabled: Bool, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    isTrainingRecordingEnabled = enabled
    resolve(true)
  }

  @objc
  func getLastTrainingRecordingPath(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    recordingQueue.async {
      resolve(self.lastTrainingRecordingURL?.path)
    }
  }

  // MARK: - Voice Filter (low-pass for playback)

  // Applies a 2-stage IIR low-pass filter (~300 Hz cutoff) to the source file and
  // writes the result to a temp WAV. Removes speech intelligibility while keeping
  // snoring and breathing sounds. Processes in 4096-frame chunks — safe for 8h files.
  @objc
  func processAudioForPlayback(
    _ sourcePath: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let sourceURL = URL(fileURLWithPath: sourcePath)
      let destURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("snorealert_filtered.wav")

      try? FileManager.default.removeItem(at: destURL)

      do {
        let sourceFile = try AVAudioFile(forReading: sourceURL)
        let format = sourceFile.processingFormat
        let totalFrames = sourceFile.length
        let channelCount = Int(format.channelCount)

        // 2-stage IIR low-pass: α = e^(-2π·fc/fs)
        // At 300 Hz / 16 kHz: α ≈ 0.889. Two stages → ~40 dB/decade above fc.
        let alpha = expf(-2.0 * Float.pi * 300.0 / Float(format.sampleRate))
        let gain = 1.0 - alpha

        let chunkSize: AVAudioFrameCount = 4096
        guard let chunk = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunkSize) else {
          reject("ERR_BUFFER", "Cannot allocate audio buffer", nil)
          return
        }

        let destFile = try AVAudioFile(forWriting: destURL, settings: format.settings)

        var z1 = [Float](repeating: 0, count: channelCount) // stage-1 state
        var z2 = [Float](repeating: 0, count: channelCount) // stage-2 state

        var framesRead: Int64 = 0
        while framesRead < totalFrames {
          let toRead = AVAudioFrameCount(min(Int64(chunkSize), totalFrames - framesRead))
          chunk.frameLength = 0
          try sourceFile.read(into: chunk, frameCount: toRead)
          guard chunk.frameLength > 0, let channelData = chunk.floatChannelData else { break }

          for ch in 0..<channelCount {
            let buf = channelData[ch]
            for i in 0..<Int(chunk.frameLength) {
              let y1 = alpha * z1[ch] + gain * buf[i]
              let y2 = alpha * z2[ch] + gain * y1
              z1[ch] = y1
              z2[ch] = y2
              buf[i] = y2
            }
          }

          try destFile.write(from: chunk)
          framesRead += Int64(chunk.frameLength)
        }

        resolve(destURL.path)
      } catch {
        reject("ERR_PROCESS", error.localizedDescription, nil)
      }
    }
  }

  // MARK: - Audio Session Observers (interruption + route change recovery)

  private func setupAudioSessionObservers() {
    let nc = NotificationCenter.default
    nc.addObserver(self,
                   selector: #selector(handleInterruption(_:)),
                   name: AVAudioSession.interruptionNotification,
                   object: AVAudioSession.sharedInstance())
    nc.addObserver(self,
                   selector: #selector(handleRouteChange(_:)),
                   name: AVAudioSession.routeChangeNotification,
                   object: AVAudioSession.sharedInstance())
    nc.addObserver(self,
                   selector: #selector(handleMediaServicesReset),
                   name: AVAudioSession.mediaServicesWereResetNotification,
                   object: AVAudioSession.sharedInstance())
  }

  private func removeAudioSessionObservers() {
    NotificationCenter.default.removeObserver(self,
                                              name: AVAudioSession.interruptionNotification,
                                              object: nil)
    NotificationCenter.default.removeObserver(self,
                                              name: AVAudioSession.routeChangeNotification,
                                              object: nil)
    NotificationCenter.default.removeObserver(self,
                                              name: AVAudioSession.mediaServicesWereResetNotification,
                                              object: nil)
  }

  @objc private func handleInterruption(_ notification: Notification) {
    guard let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
          let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

    switch type {
    case .began:
      logger.info("🎤 Audio session interrupted — engine paused by system")
      // Engine is already stopped by the system; nothing to do but log.

    case .ended:
      let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
      if options.contains(.shouldResume) {
        logger.info("🎤 Interruption ended with shouldResume — restarting engine")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
          self.restartAudioEngine(reason: "interruption-ended")
        }
      } else {
        logger.info("🎤 Interruption ended without shouldResume — restarting anyway")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
          self.restartAudioEngine(reason: "interruption-ended-no-resume")
        }
      }

    @unknown default:
      break
    }
  }

  @objc private func handleRouteChange(_ notification: Notification) {
    guard let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }

    switch reason {
    case .oldDeviceUnavailable:
      // e.g. Bluetooth headphones disconnected overnight
      logger.info("🎤 Audio route: old device unavailable — restarting engine")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        self.restartAudioEngine(reason: "route-old-device-unavailable")
      }

    case .newDeviceAvailable:
      // e.g. Bluetooth headphones connected — route may have changed away from mic
      logger.info("🎤 Audio route: new device available — restarting engine")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        self.restartAudioEngine(reason: "route-new-device")
      }

    case .categoryChange:
      logger.info("🎤 Audio route: category changed — restarting engine")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        self.restartAudioEngine(reason: "route-category-change")
      }

    default:
      break
    }
  }

  @objc private func handleMediaServicesReset() {
    // Media server crash — rebuild everything from scratch
    logger.warning("🎤 Media services were reset — rebuilding audio engine")
    audioEngine = nil
    streamAnalyzer = nil
    analysisObserver = nil
    currentFramePosition = 0
    currentPower = -160.0
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
      self.rebuildAndRestartEngine()
    }
  }

  private func restartAudioEngine(reason: String) {
    guard let engine = audioEngine else {
      logger.warning("🎤 restartAudioEngine called but engine is nil (reason: \(reason)) — rebuilding")
      rebuildAndRestartEngine()
      return
    }

    guard !engine.isRunning else {
      logger.info("🎤 Engine already running after \(reason) — no restart needed")
      return
    }

    do {
      try AVAudioSession.sharedInstance().setActive(true)
      try engine.start()
      logger.info("🎤 ✅ Engine restarted (\(reason))")
      sendEvent(withName: "NativeAudioLevel", body: [
        "level": self.currentPower,
        "mlActive": self.useMLDetection,
        "engineRestarted": true
      ])
    } catch {
      logger.error("🎤 ❌ Engine restart failed (\(reason)): \(error.localizedDescription)")
      sendEvent(withName: "NativeAudioError", body: [
        "message": "Engine restart failed: \(error.localizedDescription)"
      ])
      // Try a full rebuild as fallback
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
        self.rebuildAndRestartEngine()
      }
    }
  }

  private func rebuildAndRestartEngine() {
    guard isSessionActive else {
      // stop() was called — don't rebuild
      return
    }

    logger.info("🎤 Rebuilding audio engine from scratch")
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .default, options: [.allowBluetooth])
      try session.setActive(true)

      let engine = AVAudioEngine()
      audioEngine = engine
      let inputNode = engine.inputNode
      let inputFormat = inputNode.outputFormat(forBus: 0)

      // Rebuild ML analyzer with the (potentially new) format
      setupMLAnalysis(format: inputFormat)

      inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
        guard let self = self else { return }
        self.processTapBuffer(buffer)
      }

      try engine.start()
      logger.info("🎤 ✅ Engine rebuilt and restarted")
      sendEvent(withName: "NativeAudioLevel", body: [
        "level": -160.0,
        "mlActive": useMLDetection,
        "engineRestarted": true
      ])
    } catch {
      logger.error("🎤 ❌ Engine rebuild failed: \(error.localizedDescription)")
      sendEvent(withName: "NativeAudioError", body: [
        "message": "Engine rebuild failed: \(error.localizedDescription)"
      ])
    }
  }

  // MARK: - Audio Tap Processing

  private func processTapBuffer(_ buffer: AVAudioPCMBuffer) {
    recordingQueue.async { [weak self] in
      self?.writeTrainingBufferIfNeeded(buffer)
    }

    if let channelData = buffer.floatChannelData?[0] {
      let frameCount = Int(buffer.frameLength)
      var sum: Float = 0
      for i in 0..<frameCount {
        let s = channelData[i]
        sum += s * s
      }
      let rms = sqrt(sum / Float(max(frameCount, 1)))
      currentPower = rms > 0 ? 20.0 * log10(rms) : -160.0
    }

    if useMLDetection, let analyzer = streamAnalyzer, currentPower > mlMinimumPowerThreshold {
      let framePos = currentFramePosition
      currentFramePosition += AVAudioFramePosition(buffer.frameLength)
      analysisQueue.async {
        analyzer.analyze(buffer, atAudioFramePosition: framePos)
      }
    } else if useMLDetection {
      currentFramePosition += AVAudioFramePosition(buffer.frameLength)
    }
  }

  // MARK: - Metering Timer (emits level events to JS at 2 Hz)

  private func startMeteringTimer() {
    stopMeteringTimer()
    let timer = DispatchSource.makeTimerSource(queue: meteringQueue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(500))
    timer.setEventHandler { [weak self] in
      guard let self = self else { return }
      var trainingPath: String?
      self.recordingQueue.sync { trainingPath = self.currentTrainingRecordingURL?.path }
      self.sendEvent(withName: "NativeAudioLevel", body: [
        "level": self.currentPower,
        "mlActive": self.useMLDetection,
        "trainingRecordingPath": trainingPath as Any
      ])
    }
    timer.resume()
    meteringTimer = timer
  }

  private func stopMeteringTimer() {
    meteringTimer?.cancel()
    meteringTimer = nil
  }

  // MARK: - Core ML / Sound Analysis Setup

  private func setupMLAnalysis(format: AVAudioFormat) {
    // Clean up any existing analyzer before rebuilding
    streamAnalyzer = nil
    analysisObserver = nil

    guard let modelURL = Bundle.main.url(forResource: "SnoreClassifier", withExtension: "mlmodelc") else {
      logger.warning("⚠️ SnoreClassifier.mlmodelc not found — using dB threshold only")
      useMLDetection = false
      return
    }

    do {
      let mlModel = try MLModel(contentsOf: modelURL)
      let request = try SNClassifySoundRequest(mlModel: mlModel)
      request.windowDuration = CMTimeMakeWithSeconds(1.0, preferredTimescale: 44100)
      request.overlapFactor = 0.5

      streamAnalyzer = SNAudioStreamAnalyzer(format: format)

      let observer = SnoreAnalysisObserver(threshold: snoreConfidenceThreshold) { [weak self] confidence in
        self?.onSnoreClassified(confidence: confidence)
      }
      analysisObserver = observer
      try streamAnalyzer?.add(request, withObserver: observer)

      useMLDetection = true
      logger.info("✅ Core ML snore detection active (threshold: \(self.snoreConfidenceThreshold))")
    } catch {
      logger.error("❌ ML setup failed: \(error.localizedDescription) — falling back to dB threshold")
      useMLDetection = false
    }
  }

  // MARK: - Training Recording

  // Target format: 16 kHz 16-bit PCM mono — ~6× smaller than native Float32 48 kHz,
  // and the exact format Create ML / SoundAnalysis resamples to internally anyway.
  private static let trainingFormat: AVAudioFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16000,
    channels: 1,
    interleaved: true
  )!

  private func setupTrainingRecordingIfNeeded(format: AVAudioFormat) {
    // Must be called on recordingQueue
    guard isTrainingRecordingEnabled else {
      trainingAudioFile = nil
      trainingConverter = nil
      currentTrainingRecordingURL = nil
      return
    }

    do {
      let directory = try trainingRecordingsDirectory()
      let formatter = DateFormatter()
      formatter.dateFormat = "yyyyMMdd-HHmmss"
      let filename = "snoreguard-training-\(formatter.string(from: Date())).wav"
      let fileURL = directory.appendingPathComponent(filename)

      let targetFormat = NativeAudioRecorder.trainingFormat
      let audioFile = try AVAudioFile(forWriting: fileURL,
                                      settings: targetFormat.settings,
                                      commonFormat: .pcmFormatInt16,
                                      interleaved: true)

      guard let converter = AVAudioConverter(from: format, to: targetFormat) else {
        throw NSError(domain: "SnoreGuard", code: -1,
                      userInfo: [NSLocalizedDescriptionKey: "Could not create audio converter"])
      }

      trainingAudioFile = audioFile
      trainingConverter = converter
      currentTrainingRecordingURL = fileURL
      lastTrainingRecordingURL = fileURL
      logger.info("🎙️ Training recording: \(fileURL.lastPathComponent) (16 kHz PCM)")
    } catch {
      trainingAudioFile = nil
      trainingConverter = nil
      currentTrainingRecordingURL = nil
      isTrainingRecordingEnabled = false
      logger.error("Training recording setup failed: \(error.localizedDescription)")
      sendEvent(withName: "NativeAudioError", body: [
        "message": "Training recording setup failed: \(error.localizedDescription)"
      ])
    }
  }

  private func trainingRecordingsDirectory() throws -> URL {
    let documents = try FileManager.default.url(
      for: .documentDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = documents.appendingPathComponent("SnoreGuardTrainingSessions", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func writeTrainingBufferIfNeeded(_ buffer: AVAudioPCMBuffer) {
    // Must be called on recordingQueue
    guard isTrainingRecordingEnabled,
          let file = trainingAudioFile,
          let converter = trainingConverter else { return }

    // Calculate output frame count after resampling
    let ratio = NativeAudioRecorder.trainingFormat.sampleRate / buffer.format.sampleRate
    let outFrameCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1)
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: NativeAudioRecorder.trainingFormat,
                                           frameCapacity: outFrameCapacity) else { return }

    var consumedInput = false
    let status = converter.convert(to: outBuffer, error: nil) { _, outStatus in
      if consumedInput {
        outStatus.pointee = .noDataNow
        return nil
      }
      outStatus.pointee = .haveData
      consumedInput = true
      return buffer
    }

    guard status != .error, outBuffer.frameLength > 0 else { return }

    do {
      try file.write(from: outBuffer)
    } catch {
      logger.error("Training audio write failed: \(error.localizedDescription)")
      isTrainingRecordingEnabled = false
      trainingAudioFile = nil
      trainingConverter = nil
      sendEvent(withName: "NativeAudioError", body: [
        "message": "Training audio write failed: \(error.localizedDescription)"
      ])
    }
  }

  private func copyPCMBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
      return nil
    }
    copy.frameLength = buffer.frameLength

    if let source = buffer.floatChannelData, let destination = copy.floatChannelData {
      let channelCount = Int(buffer.format.channelCount)
      let frameCount = Int(buffer.frameLength)
      for channel in 0..<channelCount {
        destination[channel].update(from: source[channel], count: frameCount)
      }
    } else if let source = buffer.int16ChannelData, let destination = copy.int16ChannelData {
      let channelCount = Int(buffer.format.channelCount)
      let frameCount = Int(buffer.frameLength)
      for channel in 0..<channelCount {
        destination[channel].update(from: source[channel], count: frameCount)
      }
    } else if let source = buffer.int32ChannelData, let destination = copy.int32ChannelData {
      let channelCount = Int(buffer.format.channelCount)
      let frameCount = Int(buffer.frameLength)
      for channel in 0..<channelCount {
        destination[channel].update(from: source[channel], count: frameCount)
      }
    }
    return copy
  }

  // MARK: - ML Snore Event

  private func onSnoreClassified(confidence: Double) {
    logger.info("🎤 Snore classified! confidence=\(confidence) power=\(self.currentPower)")
    sendEvent(withName: "NativeAudioLevel", body: [
      "level": self.currentPower,
      "mlActive": true,
      "mlSnoreConfidence": confidence
    ])
  }
}

// MARK: - SNResultsObserving

class SnoreAnalysisObserver: NSObject, SNResultsObserving {

  private let threshold: Float
  private let onSnoreDetected: (Double) -> Void
  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "SnoreAnalysisObserver")

  // Require N consecutive snore windows before firing.
  // At overlapFactor=0.5 with 1s windows, each window is 0.5s apart → 4 = ~2s sustained.
  private let requiredConsecutiveCount: Int = 4
  // Allow this many non-snore windows within a run before resetting — handles the
  // brief confidence dip during the inhale/pause cycle of a real snore.
  private let allowedGapCount: Int = 1
  private var consecutiveCount: Int = 0
  private var currentGapCount: Int = 0

  init(threshold: Float, onSnoreDetected: @escaping (Double) -> Void) {
    self.threshold = threshold
    self.onSnoreDetected = onSnoreDetected
  }

  func request(_ request: SNRequest, didProduce result: SNResult) {
    guard let classificationResult = result as? SNClassificationResult else { return }
    if let snoreClass = classificationResult.classifications.first(where: {
      $0.identifier.lowercased().contains("snore")
    }) {
      let confidence = snoreClass.confidence
      logger.info("Snore confidence: \(confidence) consecutive: \(self.consecutiveCount) gap: \(self.currentGapCount)")

      if Float(confidence) >= threshold {
        consecutiveCount += 1
        currentGapCount = 0
        if consecutiveCount >= requiredConsecutiveCount {
          onSnoreDetected(confidence)
          consecutiveCount = 0
        }
      } else {
        currentGapCount += 1
        if currentGapCount > allowedGapCount {
          // Too many misses in a row — this isn't sustained snoring
          consecutiveCount = 0
          currentGapCount = 0
        }
        // Within the allowed gap: keep consecutiveCount to bridge the inhale dip
      }
    } else {
      currentGapCount += 1
      if currentGapCount > allowedGapCount {
        consecutiveCount = 0
        currentGapCount = 0
      }
    }
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    logger.error("Sound analysis error: \(error.localizedDescription)")
  }

  func requestDidComplete(_ request: SNRequest) {}
}
