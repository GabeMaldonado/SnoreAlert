import Foundation
import Combine
import WatchKit

@MainActor
final class ExtendedRuntimeManager: NSObject, ObservableObject, WKExtendedRuntimeSessionDelegate {
  @Published private(set) var isRunning = false
  @Published private(set) var lastStateMessage = "Idle"

  private var session: WKExtendedRuntimeSession?

  func startIfNeeded() {
    guard WKExtension.shared().applicationState == .active else {
      lastStateMessage = "Armed; waiting for active app to extend runtime"
      return
    }

    if let session, session.state == .running || session.state == .scheduled {
      lastStateMessage = "Extended runtime already active"
      return
    }

    let newSession = WKExtendedRuntimeSession()
    newSession.delegate = self
    session = newSession
    newSession.start()
    lastStateMessage = "Starting extended runtime"
  }

  func stop() {
    session?.invalidate()
    session = nil
    isRunning = false
    lastStateMessage = "Extended runtime stopped"
  }

  func extendedRuntimeSessionDidStart(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
    isRunning = true
    lastStateMessage = "Extended runtime running"
  }

  func extendedRuntimeSessionWillExpire(_ extendedRuntimeSession: WKExtendedRuntimeSession) {
    lastStateMessage = "Extended runtime expiring soon"
  }

  func extendedRuntimeSession(
    _ extendedRuntimeSession: WKExtendedRuntimeSession,
    didInvalidateWith reason: WKExtendedRuntimeSessionInvalidationReason,
    error: Error?
  ) {
    isRunning = false
    if let error {
      lastStateMessage = "Runtime invalidated: \(error.localizedDescription)"
    } else {
      lastStateMessage = "Runtime invalidated (\(reason.rawValue))"
    }
    session = nil
  }
}
