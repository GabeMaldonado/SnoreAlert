import Foundation
import WatchConnectivity
import os

@objc(WatchConnectivityBridge)
class WatchConnectivityBridge: NSObject, WCSessionDelegate {
  
  var session: WCSession?
  private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "WatchConnectivityBridge")
  
  override init() {
    super.init()
    if WCSession.isSupported() {
      session = WCSession.default
      session?.delegate = self
      session?.activate()
    }
  }
  
  @objc
  func sendVibrateCommand() {
    sendCommand("VIBRATE", retryCount: 3)
  }

  @objc
  func startWatchSession() {
    sendCommand("START_SESSION", retryCount: 1)
  }

  @objc
  func stopWatchSession() {
    sendCommand("STOP_SESSION", retryCount: 1)
  }

  private func sendCommand(_ command: String, retryCount: Int) {
    guard let session = session else {
      logger.error("Session not available")
      return
    }
    
    var message: [String: Any] = [
      "command": command,
      "timestamp": Date().timeIntervalSince1970
    ]
    
    // 1. updateApplicationContext is best for state synchronization
    do {
      try session.updateApplicationContext(message)
      logger.info("Sent via updateApplicationContext")
    } catch {
      logger.error("Error updating application context: \(error.localizedDescription)")
    }
    
    // 2. transferUserInfo is reliable for background delivery
    session.transferUserInfo(message)
    logger.info("Sent via transferUserInfo")
    
    // 3. sendMessage for immediate delivery if reachable
    if session.isReachable {
      logger.info("Watch is reachable, sending immediate message")
      session.sendMessage(message, replyHandler: nil) { [weak self] error in
        self?.logger.error("Error sending immediate message: \(error.localizedDescription)")
        if retryCount > 0 {
          self?.logger.info("Retrying in 2 seconds... (Retries left: \(retryCount))")
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            self?.sendCommand(command, retryCount: retryCount - 1)
          }
        }
      }
    } else {
      logger.info("Watch is NOT reachable (immediate message skipped)")
    }
  }
  
  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
  
  // MARK: - WCSessionDelegate
  
  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    if let error = error {
      logger.error("Activation failed: \(error.localizedDescription)")
    } else {
      logger.info("Session activated with state: \(activationState.rawValue)")
    }
  }
  
  func sessionReachabilityDidChange(_ session: WCSession) {
    logger.info("Reachability changed to: \(session.isReachable)")
  }
  
  func sessionDidBecomeInactive(_ session: WCSession) {}
  
  func sessionDidDeactivate(_ session: WCSession) {
    session.activate()
  }
  
  func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
    if let command = message["command"] as? String, command == "HEARTBEAT" {
      logger.debug("Heartbeat received from Watch at \(Date())")
    }
  }
  
  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
    if let command = userInfo["command"] as? String, command == "HEARTBEAT" {
      logger.debug("Heartbeat received via userInfo at \(Date())")
    }
  }
}


