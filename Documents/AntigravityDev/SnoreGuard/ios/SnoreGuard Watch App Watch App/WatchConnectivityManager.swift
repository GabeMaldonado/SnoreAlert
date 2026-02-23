import Foundation
import WatchConnectivity
import SwiftUI
import os

class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {

    @Published var isConnected = false

    static let shared = WatchConnectivityManager()

    private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "WatchConnectivityManager")

    private override init() {
        super.init()

        if WCSession.isSupported() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        DispatchQueue.main.async {
            self.isConnected = session.isReachable
        }
        if let error = error {
            logger.error("Session activation failed: \(error.localizedDescription)")
        } else {
            logger.info("Session activated with state: \(activationState.rawValue)")
        }
    }

    func sessionReachabilityDidChange(_ session: WCSession) {
        DispatchQueue.main.async {
            self.isConnected = session.isReachable
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {}
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {}
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {}
}
