#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(NotificationBridge, NSObject)

RCT_EXTERN_METHOD(requestAuthorization:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(scheduleImmediateNotification:(NSString *)title body:(NSString *)body)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
