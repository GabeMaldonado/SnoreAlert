import Foundation
import AVFoundation
import SoundAnalysis
import os

@objc(NativeAudioRecorder)
class NativeAudioRecorder: RCTEventEmitter {

  // MARK: - Properties

  private var audioEngine: AVAudioEngine?
  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "NativeAudioRecorder")

  // Optional full-session capture for training data.
  private let recordingQueue = DispatchQueue(label: "com.snoreguard.trainingRecording", qos: .utility)
  private var isTrainingRecordingEnabled = false
  private var trainingAudioFile: AVAudioFile?
  private var currentTrainingRecordingURL: URL?
  private var lastTrainingRecordingURL: URL?

  // Metering
  private var meteringTimer: DispatchSourceTimer?
  private let meteringQueue = DispatchQueue(label: "com.snoreguard.metering", qos: .background)
  private var currentPower: Float = -160.0

  // Sound Analysis (Core ML)
  private var streamAnalyzer: SNAudioStreamAnalyzer?
  private var analysisObserver: SnoreAnalysisObserver?
  private let analysisQueue = DispatchQueue(label: "com.snoreguard.analysis", qos: .background)
  private var useMLDetection = false
  private let snoreConfidenceThreshold: Float = 0.60
  // Minimum dB before we even bother running ML — prevents classifying silence/room noise as snoring
  // Overnight audio averages ~-55 dB, so threshold must be well below that to ensure ML runs
  private let mlMinimumPowerThreshold: Float = -70.0
  // Monotonically increasing frame position counter for SNAudioStreamAnalyzer
  private var currentFramePosition: AVAudioFramePosition = 0

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

      // Setup ML analyzer with the native input format
      setupMLAnalysis(format: inputFormat)
      setupTrainingRecordingIfNeeded(format: inputFormat)

      // Install a tap on the input node — fires every ~100ms
      inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
        guard let self = self else { return }
        self.processTapBuffer(buffer)
      }

      try engine.start()
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
    stopMeteringTimer()
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    audioEngine = nil
    streamAnalyzer = nil
    analysisObserver = nil
    currentFramePosition = 0
    currentPower = -160.0
    let recordingPath = currentTrainingRecordingURL?.path
    recordingQueue.sync {
      self.trainingAudioFile = nil
    }
    lastTrainingRecordingURL = currentTrainingRecordingURL
    currentTrainingRecordingURL = nil
    let trainingRecordingPath: Any = recordingPath ?? NSNull()
    logger.info("🛑 Stopped")
    resolve([
      "stopped": true,
      "trainingRecordingPath": trainingRecordingPath
    ])
  }

  @objc
  func setTrainingRecordingEnabled(_ enabled: Bool, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    isTrainingRecordingEnabled = enabled
    resolve(true)
  }

  @objc
  func getLastTrainingRecordingPath(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    resolve(lastTrainingRecordingURL?.path)
  }

  // MARK: - Audio Tap Processing

  private func processTapBuffer(_ buffer: AVAudioPCMBuffer) {
    writeTrainingBufferIfNeeded(buffer)

    // Compute RMS power → dB for metering
    if let channelData = buffer.floatChannelData?[0] {
      let frameCount = Int(buffer.frameLength)
      var sum: Float = 0
      for i in 0..<frameCount {
        let s = channelData[i]
        sum += s * s
      }
      let rms = sqrt(sum / Float(max(frameCount, 1)))
      let db = rms > 0 ? 20.0 * log10(rms) : -160.0
      currentPower = db
    }

    // Feed buffer to ML analyzer — only when audio is loud enough to contain meaningful signal
    if useMLDetection, let analyzer = streamAnalyzer, currentPower > mlMinimumPowerThreshold {
      let framePos = currentFramePosition
      currentFramePosition += AVAudioFramePosition(buffer.frameLength)
      analysisQueue.async {
        analyzer.analyze(buffer, atAudioFramePosition: framePos)
      }
    } else if useMLDetection {
      // Still advance the frame counter even when skipping, so positions stay consistent
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
      let trainingRecordingPath: Any = self.currentTrainingRecordingURL?.path ?? NSNull()
      self.sendEvent(withName: "NativeAudioLevel", body: [
        "level": self.currentPower,
        "mlActive": self.useMLDetection,
        "trainingRecordingPath": trainingRecordingPath
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

  private func setupTrainingRecordingIfNeeded(format: AVAudioFormat) {
    guard isTrainingRecordingEnabled else {
      trainingAudioFile = nil
      currentTrainingRecordingURL = nil
      return
    }

    do {
      let directory = try trainingRecordingsDirectory()
      let formatter = DateFormatter()
      formatter.dateFormat = "yyyyMMdd-HHmmss"
      let filename = "snoreguard-training-\(formatter.string(from: Date())).caf"
      let fileURL = directory.appendingPathComponent(filename)
      let audioFile = try AVAudioFile(forWriting: fileURL, settings: format.settings)
      recordingQueue.sync {
        self.trainingAudioFile = audioFile
      }
      currentTrainingRecordingURL = fileURL
      lastTrainingRecordingURL = fileURL
      logger.info("🎙️ Training recording enabled: \(fileURL.path)")
    } catch {
      trainingAudioFile = nil
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
    guard isTrainingRecordingEnabled, let file = trainingAudioFile else { return }
    guard let copiedBuffer = copyPCMBuffer(buffer) else { return }

    recordingQueue.async { [weak self] in
      do {
        try file.write(from: copiedBuffer)
      } catch {
        self?.logger.error("Training audio write failed: \(error.localizedDescription)")
        self?.isTrainingRecordingEnabled = false
        self?.trainingAudioFile = nil
        self?.sendEvent(withName: "NativeAudioError", body: [
          "message": "Training audio write failed: \(error.localizedDescription)"
        ])
      }
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
    logger.info("🎤 Snore classified! confidence=\(confidence)")
    // Send a level well above any dB threshold so JS fires the notification
    sendEvent(withName: "NativeAudioLevel", body: [
      "level": 10.0,
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
  // Require this many consecutive snore windows before firing — filters out brief voice/sounds
  // At overlapFactor=0.5 with 1s windows, each window is 0.5s apart, so 2 = ~1s sustained snoring
  private let requiredConsecutiveCount: Int = 2
  private var consecutiveCount: Int = 0

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
      logger.info("Snore confidence: \(confidence) consecutive: \(self.consecutiveCount)")
      if Float(confidence) >= threshold {
        consecutiveCount += 1
        if consecutiveCount >= requiredConsecutiveCount {
          onSnoreDetected(confidence)
          // Reset so next trigger also requires sustained detection
          consecutiveCount = 0
        }
      } else {
        consecutiveCount = 0
      }
    } else {
      consecutiveCount = 0
    }
  }

  func request(_ request: SNRequest, didFailWithError error: Error) {
    logger.error("Sound analysis error: \(error.localizedDescription)")
  }

  func requestDidComplete(_ request: SNRequest) {}
}
