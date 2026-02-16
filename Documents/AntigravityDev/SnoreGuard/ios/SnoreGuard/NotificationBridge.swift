import Foundation
import UserNotifications
import os

@objc(NotificationBridge)
class NotificationBridge: NSObject {

  private let logger = Logger(subsystem: "com.antigravity.snoreguard", category: "NotificationBridge")

  @objc
  func requestAuthorization(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
      if let error = error {
        self.logger.error("Notification authorization error: \(error.localizedDescription)")
        reject("AUTH_ERROR", "Failed to request authorization", error)
      } else {
        self.logger.info("Notification authorization granted: \(granted)")
        resolve(granted)
      }
    }
  }

  @objc
  func scheduleImmediateNotification(_ title: String, body: String) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default

    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false)
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)

    UNUserNotificationCenter.current().add(request) { error in
      if let error = error {
        self.logger.error("Failed to schedule notification: \(error.localizedDescription)")
      } else {
        self.logger.info("Notification scheduled: \(title)")
      }
    }
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
