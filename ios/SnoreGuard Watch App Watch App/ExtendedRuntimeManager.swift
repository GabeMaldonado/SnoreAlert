     1→import Foundation
     2→import WatchKit
     3→import os
     4→import Combine
     5→
     6→class ExtendedRuntimeManager: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
     7→    static let shared = ExtendedRuntimeManager()
     8→    
     9→    @Published var isSessionRunning = false
    10→    
    11→    private var session: WKExtendedRuntimeSession?
    12→    private var autoRestartEnabled = false
    13→    private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "ExtendedRuntimeManager")
    14→    
    15→    private override init() {
    16→        super.init()
    17→    }
    18→    
    19→    func startSession(autoRestart: Bool = false) {
    20→        if isSessionRunning {
    21→            autoRestartEnabled = autoRestart
    22→            return
    23→        }
    24→        autoRestartEnabled = autoRestart
    25→        
    26→        let newSession = WKExtendedRuntimeSession()
    27→        newSession.delegate = self
    28→        session = newSession
    29→        newSession.start()
    30→        logger.info("Extended runtime session started")
    31→    }
    32→    
    33→    func stopSession() {
    34→        autoRestartEnabled = false
    35→        session?.invalidate()
    36→        session = nil
    37→        logger.info("Extended runtime session stopped")
    38→    }
    39→    
    40→    // MARK: - WKExtendedRuntimeSessionDelegate
    41→    
    42→    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
    43→        DispatchQueue.main.async {
    44→            self.isSessionRunning = true
    45→        }
    46→        logger.info("Extended runtime session did start")
    47→    }
    48→    
    49→    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
    50→        logger.info("Extended runtime session will expire")
    51→    }
    52→    
    53→    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {
    54→        DispatchQueue.main.async {
    55→            self.isSessionRunning = false
    56→        }
    57→        if let error = error {
    58→            logger.error("Extended runtime session invalidated: \(error.localizedDescription)")
    59→        } else {
    60→            logger.info("Extended runtime session invalidated: \(reason.rawValue)")
    61→        }
    62→        
    63→        if autoRestartEnabled {
    64→            DispatchQueue.main.asyncAfter(deadline: .now() + AppConfig.Watch.sessionRestartDelay) { [weak self] in
    65→                self?.startSession(autoRestart: true)
    66→            }
    67→        }
    68→    }
    69→}
    70→

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>
