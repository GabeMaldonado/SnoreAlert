import Foundation
import WatchKit
import os
import Combine

class ExtendedRuntimeManager: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
    static let shared = ExtendedRuntimeManager()

    @Published var isSessionRunning = false

    private var session: WKExtendedRuntimeSession?
    private var autoRestartEnabled = false
    private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "ExtendedRuntimeManager")

    private override init() {
        super.init()
    }

    func startSession(autoRestart: Bool = false) {
        if isSessionRunning {
            autoRestartEnabled = autoRestart
            return
        }
        autoRestartEnabled = autoRestart

        let newSession = WKExtendedRuntimeSession()
        newSession.delegate = self
        session = newSession
        newSession.start()
        logger.info("Extended runtime session started")
    }

    func stopSession() {
        autoRestartEnabled = false
        session?.invalidate()
        session = nil
        logger.info("Extended runtime session stopped")
    }

    // MARK: - WKExtendedRuntimeSessionDelegate

    func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        DispatchQueue.main.async {
            self.isSessionRunning = true
        }
        logger.info("Extended runtime session did start")
    }

    func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
        logger.info("Extended runtime session will expire")
    }

    func extendedRuntimeSession(_ extendedRuntimeSession: WKExtendedRuntimeSession, didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason, error: Error?) {
        DispatchQueue.main.async {
            self.isSessionRunning = false
        }
        if let error = error {
            logger.error("Extended runtime session invalidated: \(error.localizedDescription)")
        } else {
            logger.info("Extended runtime session invalidated: \(reason.rawValue)")
        }

        if autoRestartEnabled {
            DispatchQueue.main.asyncAfter(deadline: .now() + AppConfig.Watch.sessionRestartDelay) { [weak self] in
                self?.startSession(autoRestart: true)
            }
        }
    }
}
