     1→import Foundation
     2→import WatchConnectivity
     3→import os
     4→
     5→@objc(WatchConnectivityBridge)
     6→class WatchConnectivityBridge: NSObject, WCSessionDelegate {
     7→  
     8→  var session: WCSession?
     9→  private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "WatchConnectivityBridge")
    10→  
    11→  override init() {
    12→    super.init()
    13→    if WCSession.isSupported() {
    14→      session = WCSession.default
    15→      session?.delegate = self
    16→      session?.activate()
    17→    }
    18→  }
    19→  
    20→  @objc
    21→  func sendVibrateCommand() {
    22→    sendCommand("VIBRATE", retryCount: 3)
    23→  }
    24→
    25→  @objc
    26→  func startWatchSession() {
    27→    sendCommand("START_SESSION", retryCount: 1)
    28→  }
    29→
    30→  @objc
    31→  func stopWatchSession() {
    32→    sendCommand("STOP_SESSION", retryCount: 1)
    33→  }
    34→
    35→  private func sendCommand(_ command: String, retryCount: Int) {
    36→    guard let session = session else {
    37→      logger.error("Session not available")
    38→      return
    39→    }
    40→    
    41→    var message: [String: Any] = [
    42→      "command": command,
    43→      "timestamp": Date().timeIntervalSince1970
    44→    ]
    45→    
    46→    // 1. updateApplicationContext is best for state synchronization
    47→    do {
    48→      try session.updateApplicationContext(message)
    49→      logger.info("Sent via updateApplicationContext")
    50→    } catch {
    51→      logger.error("Error updating application context: \(error.localizedDescription)")
    52→    }
    53→    
    54→    // 2. transferUserInfo is reliable for background delivery
    55→    session.transferUserInfo(message)
    56→    logger.info("Sent via transferUserInfo")
    57→    
    58→    // 3. sendMessage for immediate delivery if reachable
    59→    if session.isReachable {
    60→      logger.info("Watch is reachable, sending immediate message")
    61→      session.sendMessage(message, replyHandler: nil) { [weak self] error in
    62→        self?.logger.error("Error sending immediate message: \(error.localizedDescription)")
    63→        if retryCount > 0 {
    64→          self?.logger.info("Retrying in 2 seconds... (Retries left: \(retryCount))")
    65→          DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
    66→            self?.sendCommand(command, retryCount: retryCount - 1)
    67→          }
    68→        }
    69→      }
    70→    } else {
    71→      logger.info("Watch is NOT reachable (immediate message skipped)")
    72→    }
    73→  }
    74→  
    75→  @objc
    76→  static func requiresMainQueueSetup() -> Bool {
    77→    return false
    78→  }
    79→  
    80→  // MARK: - WCSessionDelegate
    81→  
    82→  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    83→    if let error = error {
    84→      logger.error("Activation failed: \(error.localizedDescription)")
    85→    } else {
    86→      logger.info("Session activated with state: \(activationState.rawValue)")
    87→    }
    88→  }
    89→  
    90→  func sessionReachabilityDidChange(_ session: WCSession) {
    91→    logger.info("Reachability changed to: \(session.isReachable)")
    92→  }
    93→  
    94→  func sessionDidBecomeInactive(_ session: WCSession) {}
    95→  
    96→  func sessionDidDeactivate(_ session: WCSession) {
    97→    session.activate()
    98→  }
    99→  
   100→  func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
   101→    if let command = message["command"] as? String, command == "HEARTBEAT" {
   102→      logger.debug("Heartbeat received from Watch at \(Date())")
   103→    }
   104→  }
   105→  
   106→  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
   107→    if let command = userInfo["command"] as? String, command == "HEARTBEAT" {
   108→      logger.debug("Heartbeat received via userInfo at \(Date())")
   109→    }
   110→  }
   111→}
   112→

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>
