import Foundation
import os

@objc(SleepSessionBridge)
class SleepSessionBridge: NSObject {

  private var sessionData: [[String: Any]] = []
  private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "SleepSessionBridge")

  @objc
  func startSleepSession() {
    logger.info("Sleep session started")
    sessionData = []
  }

  @objc
  func stopSleepSession() {
    logger.info("Sleep session stopped with \(self.sessionData.count) data points")
  }

  @objc
  func logDataPoint(_ dataPoint: NSDictionary) {
    sessionData.append(dataPoint as! [String: Any])
  }

  @objc
  func getNativeData(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    logger.info("Returning \(self.sessionData.count) data points from native storage")
    resolve(sessionData)
  }

  @objc
  func clearNativeData() {
    logger.info("Clearing native data (\(self.sessionData.count) points)")
    sessionData = []
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
