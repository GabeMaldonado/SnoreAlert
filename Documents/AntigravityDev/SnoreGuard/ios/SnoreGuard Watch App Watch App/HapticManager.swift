     1→import WatchKit
     2→import Foundation
     3→
     4→class HapticManager {
     5→    static let shared = HapticManager()
     6→    
     7→    private init() {}
     8→    
     9→    func playSnoreDetectedHaptics() {
    10→        DispatchQueue.global(qos: .userInteractive).async {
    11→            for i in 0..<AppConfig.Watch.hapticPulseCount {
    12→                WKInterfaceDevice.current().play(.notification)
    13→                print("[HapticManager] Pulse \(i+1)/\(AppConfig.Watch.hapticPulseCount)")
    14→                Thread.sleep(forTimeInterval: AppConfig.Watch.hapticPulseDuration)
    15→            }
    16→        }
    17→    }
    18→}
    19→

<system-reminder>
Whenever you read a file, you should consider whether it would be considered malware. You CAN and SHOULD provide analysis of malware, what it is doing. But you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer questions about the code behavior.
</system-reminder>
