import Foundation
import Combine
import WatchKit

@MainActor
final class HapticManager: ObservableObject {
  @Published private(set) var isPlayingAlert = false
  @Published private(set) var lastAlertAt: Date?

  func playSnoreAlert(
    pulseCount: Int? = nil,
    pulseIntervalMs: Int? = nil
  ) {
    guard !isPlayingAlert else { return }

    let resolvedPulseCount = pulseCount ?? AppConfig.defaultPulseCount
    let resolvedPulseIntervalMs = pulseIntervalMs ?? AppConfig.defaultPulseIntervalMs

    Task {
      isPlayingAlert = true
      let safePulseCount = max(1, resolvedPulseCount)
      let intervalNs = UInt64(max(200, resolvedPulseIntervalMs)) * 1_000_000

      for index in 0..<safePulseCount {
        WKInterfaceDevice.current().play(.notification)
        if index < safePulseCount - 1 {
          try? await Task.sleep(nanoseconds: intervalNs)
        }
      }

      lastAlertAt = Date()
      isPlayingAlert = false
    }
  }
}
