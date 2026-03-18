import Foundation

@objc(WatchConnectivityBridge)
final class WatchConnectivityBridge: NSObject {
  @objc func startWatchSession() {}
  @objc func sendVibrateCommand() {}
  @objc static func requiresMainQueueSetup() -> Bool { false }
}
