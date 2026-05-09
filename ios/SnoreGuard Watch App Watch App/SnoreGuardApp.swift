import SwiftUI
import WatchKit

@main
struct SnoreGuardWatchApp: App {
  @WKApplicationDelegateAdaptor private var appDelegate: WatchAppDelegate
  @StateObject private var hapticManager: HapticManager
  @StateObject private var runtimeManager: ExtendedRuntimeManager
  @StateObject private var connectivityManager: WatchConnectivityManager

  init() {
    let hapticManager = HapticManager()
    let runtimeManager = ExtendedRuntimeManager()
    let connectivityManager = WatchConnectivityManager(
      hapticManager: hapticManager,
      runtimeManager: runtimeManager
    )
    _hapticManager = StateObject(wrappedValue: hapticManager)
    _runtimeManager = StateObject(wrappedValue: runtimeManager)
    _connectivityManager = StateObject(wrappedValue: connectivityManager)
    appDelegate.configure(connectivityManager: connectivityManager, runtimeManager: runtimeManager)
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .environmentObject(hapticManager)
        .environmentObject(runtimeManager)
        .environmentObject(connectivityManager)
        .task {
          connectivityManager.activate()
        }
    }
  }
}
