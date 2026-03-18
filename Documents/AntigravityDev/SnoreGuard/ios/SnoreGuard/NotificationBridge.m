#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(NotificationBridge, NSObject)

RCT_EXTERN_METHOD(requestAuthorization:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(scheduleImmediateNotification:(NSString *)title body:(NSString *)body)
RCT_EXTERN_METHOD(scheduleDailyReminderAt:(NSInteger)hour minute:(NSInteger)minute)
RCT_EXTERN_METHOD(cancelDailyReminder)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
