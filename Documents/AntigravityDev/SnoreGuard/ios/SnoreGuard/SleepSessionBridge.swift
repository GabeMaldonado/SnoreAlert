import Foundation
import os

@objc(SleepSessionBridge)
class SleepSessionBridge: NSObject {

  private var sessionData: [[String: Any]] = []
  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "SleepSessionBridge")
  private var pointsSinceLastFlush = 0
  private let flushInterval = 10 // write to disk every 10 data points (~50 seconds)

  private let sessionFileURL: URL = {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    return docs.appendingPathComponent("snoreguard_active_session.json")
  }()

  @objc
  func startSleepSession() {
    logger.info("Sleep session started")
    sessionData = []
    pointsSinceLastFlush = 0
    // Clear any leftover file from a previous session
    try? FileManager.default.removeItem(at: sessionFileURL)
  }

  @objc
  func stopSleepSession() {
    logger.info("Sleep session stopped with \(self.sessionData.count) data points")
    // Final flush so the file is up-to-date before React Native reads it
    flushToDisk()
  }

  @objc
  func logDataPoint(_ dataPoint: NSDictionary) {
    sessionData.append(dataPoint as! [String: Any])
    pointsSinceLastFlush += 1
    if pointsSinceLastFlush >= flushInterval {
      flushToDisk()
      pointsSinceLastFlush = 0
    }
  }

  @objc
  func getNativeData(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    if sessionData.isEmpty {
      // App was killed mid-session — try to recover from the last disk flush
      if let data = try? Data(contentsOf: sessionFileURL),
         let loaded = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
         !loaded.isEmpty {
        sessionData = loaded
        logger.info("Recovered \(loaded.count) data points from disk after app restart")
      }
    }
    logger.info("Returning \(self.sessionData.count) data points from native storage")
    resolve(sessionData)
  }

  @objc
  func clearNativeData() {
    logger.info("Clearing native data (\(self.sessionData.count) points)")
    sessionData = []
    pointsSinceLastFlush = 0
    try? FileManager.default.removeItem(at: sessionFileURL)
  }

  // MARK: - Private

  private func flushToDisk() {
    guard !sessionData.isEmpty else { return }
    do {
      let data = try JSONSerialization.data(withJSONObject: sessionData)
      try data.write(to: sessionFileURL, options: .atomic)
      logger.debug("Flushed \(self.sessionData.count) points to disk")
    } catch {
      logger.error("Failed to flush session to disk: \(error.localizedDescription)")
    }
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
