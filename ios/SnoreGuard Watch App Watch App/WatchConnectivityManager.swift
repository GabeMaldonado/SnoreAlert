import Foundation
import Combine
import WatchConnectivity
import WatchKit

@MainActor
final class WatchConnectivityManager: NSObject, ObservableObject, WCSessionDelegate {
  @Published private(set) var activationStateText = "Not activated"
  @Published private(set) var isReachable = false
  @Published private(set) var isMonitoring = false
  @Published private(set) var lastMessage = "Waiting for iPhone"

  private let hapticManager: HapticManager
  private let runtimeManager: ExtendedRuntimeManager
  private var activationStateObservation: NSKeyValueObservation?
  private var hasContentPendingObservation: NSKeyValueObservation?
  private var pendingBackgroundTasks: [WKWatchConnectivityRefreshBackgroundTask] = []
  private var processedMessageIDs: [String] = []

  init(hapticManager: HapticManager, runtimeManager: ExtendedRuntimeManager) {
    self.hapticManager = hapticManager
    self.runtimeManager = runtimeManager
    super.init()
  }

  func activate() {
    guard WCSession.isSupported() else {
      activationStateText = "WatchConnectivity unavailable"
      return
    }

    let session = WCSession.default
    session.delegate = self
    configureObserversIfNeeded(for: session)
    session.activate()
    activationStateText = "Activating"
  }

  func enqueueBackgroundTasks(_ tasks: [WKWatchConnectivityRefreshBackgroundTask]) {
    pendingBackgroundTasks.append(contentsOf: tasks)
    completePendingBackgroundTasksIfPossible()
  }

  func session(
    _ session: WCSession,
    activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    Task { @MainActor in
      if let error {
        self.activationStateText = "Activation failed: \(error.localizedDescription)"
      } else {
        self.activationStateText = "Activated (\(activationState.rawValue))"
        self.isReachable = session.isReachable
      }

      self.completePendingBackgroundTasksIfPossible()
    }
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    Task { @MainActor in
      self.isReachable = session.isReachable
    }
  }

  func session(_ session: WCSession, didReceiveMessage message: [String : Any]) {
    Task { @MainActor in
      self.handle(payload: message)
    }
  }

  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
    Task { @MainActor in
      self.handle(payload: applicationContext)
    }
  }

  func session(_ session: WCSession, didReceiveUserInfo userInfo: [String : Any] = [:]) {
    Task { @MainActor in
      self.handle(payload: userInfo)
    }
  }

  private func handle(payload: [String: Any]) {
    if shouldIgnoreDuplicatePayload(payload) {
      lastMessage = "Duplicate alert ignored"
      completePendingBackgroundTasksIfPossible()
      return
    }

    if let monitoring = payload["isMonitoring"] as? Bool {
      isMonitoring = monitoring
      lastMessage = monitoring ? "Monitoring armed from iPhone" : "Monitoring stopped on iPhone"
      if monitoring {
        runtimeManager.startIfNeeded()
      } else {
        runtimeManager.stop()
      }
    }

    guard let command = payload["command"] as? String, command == AppConfig.alertCommand else {
      completePendingBackgroundTasksIfPossible()
      return
    }

    let pulseCount = payload["pulseCount"] as? Int ?? AppConfig.defaultPulseCount
    let pulseIntervalMs = payload["pulseIntervalMs"] as? Int ?? AppConfig.defaultPulseIntervalMs

    runtimeManager.startIfNeeded()
    hapticManager.playSnoreAlert(pulseCount: pulseCount, pulseIntervalMs: pulseIntervalMs)
    lastMessage = "Snore alert received"
    completePendingBackgroundTasksIfPossible()
  }

  private func configureObserversIfNeeded(for session: WCSession) {
    guard activationStateObservation == nil, hasContentPendingObservation == nil else {
      return
    }

    activationStateObservation = session.observe(\.activationState, options: [.initial, .new]) { [weak self] _, _ in
      Task { [weak self] in
        await self?.completePendingBackgroundTasksIfPossible()
      }
    }

    hasContentPendingObservation = session.observe(\.hasContentPending, options: [.initial, .new]) { [weak self] _, _ in
      Task { [weak self] in
        await self?.completePendingBackgroundTasksIfPossible()
      }
    }
  }

  private func completePendingBackgroundTasksIfPossible() {
    guard !pendingBackgroundTasks.isEmpty else { return }

    let session = WCSession.default
    let canComplete = session.activationState != .activated || !session.hasContentPending

    guard canComplete else { return }

    pendingBackgroundTasks.forEach { $0.setTaskCompletedWithSnapshot(false) }
    pendingBackgroundTasks.removeAll()
  }

  private func shouldIgnoreDuplicatePayload(_ payload: [String: Any]) -> Bool {
    guard let messageID = payload["messageId"] as? String else {
      return false
    }

    if processedMessageIDs.contains(messageID) {
      return true
    }

    processedMessageIDs.append(messageID)

    if processedMessageIDs.count > 50 {
      processedMessageIDs.removeFirst(processedMessageIDs.count - 50)
    }

    return false
  }
}
