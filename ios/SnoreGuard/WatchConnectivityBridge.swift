import Foundation
import WatchConnectivity
import os

@objc(WatchConnectivityBridge)
final class WatchConnectivityBridge: NSObject, WCSessionDelegate {
  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "WatchConnectivityBridge")
  private let isoFormatter = ISO8601DateFormatter()
  private let pulseCount = 5
  private let pulseIntervalMs = 700
  private var didActivateSession = false
  private var heartbeatTimer: Timer?
  private var pendingMonitoringState: Bool? = nil

  private var watchSession: WCSession? {
    guard WCSession.isSupported() else { return nil }
    return WCSession.default
  }

  @objc
  func startWatchSession() {
    activateSessionIfNeeded()
    if watchSession?.activationState == .activated {
      sendMonitoringState(isMonitoring: true)
      startHeartbeatTimer()
    } else {
      // Activation is async — send once the delegate fires
      pendingMonitoringState = true
    }
  }

  @objc
  func stopWatchSession() {
    pendingMonitoringState = nil
    DispatchQueue.main.async { [weak self] in
      self?.heartbeatTimer?.invalidate()
      self?.heartbeatTimer = nil
    }
    activateSessionIfNeeded()
    if watchSession?.activationState == .activated {
      sendMonitoringState(isMonitoring: false)
    }
  }

  private func startHeartbeatTimer() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.heartbeatTimer?.invalidate()
      self.heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
        self?.sendMonitoringState(isMonitoring: true)
      }
    }
  }

  @objc
  func sendVibrateCommand() {
    activateSessionIfNeeded()

    let payload: [String: Any] = [
      "messageId": UUID().uuidString,
      "command": "snore_alert",
      "pulseCount": pulseCount,
      "pulseIntervalMs": pulseIntervalMs,
      "sentAt": isoFormatter.string(from: Date())
    ]

    sendImmediatePayload(payload)
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    false
  }

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if let error {
      logger.error("WCSession activation failed: \(error.localizedDescription)")
      return
    }

    logger.info("WCSession activated with state \(activationState.rawValue)")

    if let pending = pendingMonitoringState {
      pendingMonitoringState = nil
      sendMonitoringState(isMonitoring: pending)
      if pending { startHeartbeatTimer() }
    }
  }

  func sessionDidBecomeInactive(_ session: WCSession) {
    logger.info("WCSession became inactive")
  }

  func sessionDidDeactivate(_ session: WCSession) {
    logger.info("WCSession deactivated; reactivating")
    session.activate()
  }

  private func activateSessionIfNeeded() {
    guard let session = watchSession else {
      logger.error("WatchConnectivity not supported on this device")
      return
    }

    if !didActivateSession {
      session.delegate = self
      session.activate()
      didActivateSession = true
      logger.info("Requested WCSession activation")
    }
  }

  private func sendMonitoringState(isMonitoring: Bool) {
    guard let session = watchSession else { return }

    let context: [String: Any] = [
      "messageId": UUID().uuidString,
      "isMonitoring": isMonitoring,
      "pulseCount": pulseCount,
      "pulseIntervalMs": pulseIntervalMs,
      "updatedAt": isoFormatter.string(from: Date())
    ]

    do {
      try session.updateApplicationContext(context)
      logger.info("Updated watch monitoring state: \(isMonitoring)")
    } catch {
      logger.error("Failed to update watch application context: \(error.localizedDescription)")
    }

    session.transferUserInfo(context)
    logger.info("Queued watch monitoring state for background delivery")

    if session.isReachable {
      session.sendMessage(context, replyHandler: nil) { [logger] error in
        logger.error("Failed to send monitoring message: \(error.localizedDescription)")
      }
    }
  }

  private func sendImmediatePayload(_ payload: [String: Any]) {
    guard let session = watchSession else { return }

    session.transferUserInfo(payload)
    logger.info("Queued watch alert userInfo transfer")

    if session.isReachable {
      session.sendMessage(payload, replyHandler: nil) { [logger] error in
        logger.error("Failed to send watch alert message: \(error.localizedDescription)")
      }
      logger.info("Sent immediate watch alert message")
    }
  }
}
