import Combine
import Foundation
import WatchKit

@MainActor
final class WatchAppDelegate: NSObject, WKApplicationDelegate, ObservableObject {
  let objectWillChange = ObservableObjectPublisher()
  private weak var connectivityManager: WatchConnectivityManager?
  private weak var runtimeManager: ExtendedRuntimeManager?

  func configure(
    connectivityManager: WatchConnectivityManager,
    runtimeManager: ExtendedRuntimeManager
  ) {
    self.connectivityManager = connectivityManager
    self.runtimeManager = runtimeManager
  }

  func applicationDidBecomeActive() {
    connectivityManager?.activate()

    if connectivityManager?.isMonitoring == true {
      runtimeManager?.startIfNeeded()
    }
  }

  func handle(_ backgroundTasks: Set<WKRefreshBackgroundTask>) {
    var connectivityTasks: [WKWatchConnectivityRefreshBackgroundTask] = []

    for task in backgroundTasks {
      if let connectivityTask = task as? WKWatchConnectivityRefreshBackgroundTask {
        connectivityTasks.append(connectivityTask)
      } else {
        task.setTaskCompletedWithSnapshot(false)
      }
    }

    connectivityManager?.activate()

    if connectivityTasks.isEmpty {
      return
    }

    if let connectivityManager {
      connectivityManager.enqueueBackgroundTasks(connectivityTasks)
    } else {
      connectivityTasks.forEach { $0.setTaskCompletedWithSnapshot(false) }
    }
  }
}
