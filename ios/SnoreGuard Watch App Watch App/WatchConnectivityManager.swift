     1→import Foundation
     2→import WatchConnectivity
     3→import SwiftUI
     4→import Combine
     5→import WatchKit
     6→import os
     7→
     8→class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {
     9→    
    10→    @Published var isConnected = false
    11→    @Published var lastMessageReceived: String = "Waiting..."
    12→    
    13→    static let shared = WatchConnectivityManager()
    14→    private var lastProcessedTimestamp: Double = 0
    15→    
    16→    private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "WatchConnectivityManager")
    17→    
    18→    private override init() {
    19→        super.init()
    20→        
    21→        if WCSession.isSupported() {
    22→            let session = WCSession.default
    23→            session.delegate = self
    24→            session.activate()
    25→        }
    26→    }
    27→    
    28→    // MARK: - WCSessionDelegate
    29→    
    30→    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    31→        DispatchQueue.main.async {
    32→            self.isConnected = session.isReachable
    33→        }
    34→        if let error = error {
    35→            logger.error("Session activation failed: \(error.localizedDescription)")
    36→        } else {
    37→            logger.info("Session activated with state: \(activationState.rawValue)")
    38→        }
    39→    }
    40→    
    41→    func sessionReachabilityDidChange(_ session: WCSession) {
    42→        DispatchQueue.main.async {
    43→            self.isConnected = session.isReachable
    44→        }
    45→        logger.info("Reachability changed: \(session.isReachable)")
    46→    }
    47→    
    48→    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
    49→        handleCommand(from: message)
    50→    }
    51→    
    52→    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
    53→        handleCommand(from: userInfo)
    54→    }
    55→    
    56→    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
    57→        handleCommand(from: applicationContext)
    58→    }
    59→
    60→    #if os(iOS)
    61→    func sessionDidBecomeInactive(_ session: WCSession) {}
    62→    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    63→    #endif
    64→    
    65→    private func handleCommand(from message: [String: Any]) {
    66→        guard let command = message["command"] as? String else { return }
    67→        
    68→        switch command {
    69→        case "VIBRATE":
    70→            handleVibrateCommand(from: message)
    71→        case "START_SESSION":
    72→            ExtendedRuntimeManager.shared.startSession(autoRestart: true)
    73→            DispatchQueue.main.async {
    74→                self.lastMessageReceived = "Sleep session started"
    75→            }
    76→        case "STOP_SESSION":
    77→            ExtendedRuntimeManager.shared.stopSession()
    78→            DispatchQueue.main.async {
    79→                self.lastMessageReceived = "Sleep session stopped"
    80→            }
    81→        default:
    82→            break
    83→        }
    84→    }
    85→
    86→    private func handleVibrateCommand(from message: [String: Any]) {
    87→        guard let command = message["command"] as? String, command == "VIBRATE" else { return }
    88→        
    89→        // De-duplicate messages using timestamp
    90→        if let timestamp = message["timestamp"] as? Double {
    91→            if timestamp <= lastProcessedTimestamp {
    92→                logger.info("Ignoring duplicate message")
    93→                return
    94→            }
    95→            lastProcessedTimestamp = timestamp
    96→        }
    97→        
    98→        // Update UI
    99→        DispatchQueue.main.async {
   100→            self.lastMessageReceived = "Snore detected!"
   101→        }
   102→        
   103→        // Play haptics using the new manager
   104→        HapticManager.shared.playSnoreDetectedHaptics()
   105→    }
   106→}
   107→

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>
