import WatchKit
import Foundation

class HapticManager {
    static let shared = HapticManager()

    private init() {}

    func playSnoreDetectedHaptics() {
        DispatchQueue.global(qos: .userInteractive).async {
            for i in 0..<AppConfig.Watch.hapticPulseCount {
                WKInterfaceDevice.current().play(.notification)
                print("[HapticManager] Pulse \(i+1)/\(AppConfig.Watch.hapticPulseCount)")
                Thread.sleep(forTimeInterval: AppConfig.Watch.hapticPulseDuration)
            }
        }
    }
}
