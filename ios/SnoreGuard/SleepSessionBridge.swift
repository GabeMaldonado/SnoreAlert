import Foundation
import os
import UIKit

@objc(SleepSessionBridge)
class SleepSessionBridge: NSObject {

  private var sessionData: [[String: Any]] = []
  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "SleepSessionBridge")
  private var pointsSinceLastFlush = 0
  private let flushInterval = 10
  private let dataQueue = DispatchQueue(label: "com.agenticdevlabs.snoreguard.sessionbridge", qos: .utility)

  private let sessionFileURL: URL = {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    return docs.appendingPathComponent("snoreguard_active_session.json")
  }()

  override init() {
    super.init()
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleResignActive),
      name: UIApplication.willResignActiveNotification,
      object: nil
    )
  }

  deinit {
    NotificationCenter.default.removeObserver(self)
  }

  @objc
  func startSleepSession() {
    dataQueue.async { [weak self] in
      guard let self else { return }
      self.logger.info("Sleep session started")
      self.sessionData = []
      self.pointsSinceLastFlush = 0
      try? FileManager.default.removeItem(at: self.sessionFileURL)
    }
  }

  @objc
  func stopSleepSession() {
    dataQueue.async { [weak self] in
      guard let self else { return }
      self.logger.info("Sleep session stopped with \(self.sessionData.count) data points")
      self.flushToDiskLocked()
    }
  }

  @objc
  func logDataPoint(_ dataPoint: NSDictionary) {
    guard let point = dataPoint as? [String: Any] else {
      logger.error("logDataPoint received unexpected type, dropping")
      return
    }
    dataQueue.async { [weak self] in
      guard let self else { return }
      self.sessionData.append(point)
      self.pointsSinceLastFlush += 1
      if self.pointsSinceLastFlush >= self.flushInterval {
        self.flushToDiskLocked()
        self.pointsSinceLastFlush = 0
      }
    }
  }

  @objc
  func getNativeData(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    dataQueue.async { [weak self] in
      guard let self else { resolve([]); return }
      if self.sessionData.isEmpty {
        if let data = try? Data(contentsOf: self.sessionFileURL),
           let loaded = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
           !loaded.isEmpty {
          self.sessionData = loaded
          self.logger.info("Recovered \(loaded.count) data points from disk after app restart")
        }
      }
      self.logger.info("Returning \(self.sessionData.count) data points from native storage")
      resolve(self.sessionData)
    }
  }

  @objc
  func clearNativeData() {
    dataQueue.async { [weak self] in
      guard let self else { return }
      self.logger.info("Clearing native data (\(self.sessionData.count) points)")
      self.sessionData = []
      self.pointsSinceLastFlush = 0
      try? FileManager.default.removeItem(at: self.sessionFileURL)
    }
  }

  // MARK: - Private

  @objc private func handleResignActive() {
    dataQueue.async { [weak self] in
      self?.flushToDiskLocked()
    }
  }

  // Must be called from dataQueue
  private func flushToDiskLocked() {
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
