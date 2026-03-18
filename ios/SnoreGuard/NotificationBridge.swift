import Foundation
import UserNotifications
import os

@objc(NotificationBridge)
class NotificationBridge: NSObject {

  private let logger = Logger(subsystem: "com.agenticdevlabs.snoreguard", category: "NotificationBridge")

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
  func scheduleDailyReminderAt(_ hour: Int, minute: Int) {
    let identifier = "snoreguard-daily-reminder"
    // Remove any existing daily reminder first
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: [identifier])

    let content = UNMutableNotificationContent()
    content.title = "SnoreAlert"
    content.body = "🌙 Time to track your sleep! Make sure your iPhone is charged and ready."
    content.sound = .default

    var dateComponents = DateComponents()
    dateComponents.hour = hour
    dateComponents.minute = minute

    let trigger = UNCalendarNotificationTrigger(dateMatching: dateComponents, repeats: true)
    let request = UNNotificationRequest(identifier: identifier, content: content, trigger: trigger)

    UNUserNotificationCenter.current().add(request) { [weak self] error in
      if let error = error {
        self?.logger.error("Failed to schedule daily reminder: \(error.localizedDescription)")
      } else {
        self?.logger.info("Daily reminder scheduled for \(hour):\(String(format: "%02d", minute)) daily")
      }
    }
  }

  @objc
  func cancelDailyReminder() {
    UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["snoreguard-daily-reminder"])
    logger.info("Daily reminder cancelled")
  }

  @objc
  static func requiresMainQueueSetup() -> Bool {
    return false
  }
}
