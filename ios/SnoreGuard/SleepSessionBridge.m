#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(SleepSessionBridge, NSObject)

RCT_EXTERN_METHOD(startSleepSession)
RCT_EXTERN_METHOD(stopSleepSession)
RCT_EXTERN_METHOD(logDataPoint:(NSDictionary *)dataPoint)
RCT_EXTERN_METHOD(getNativeData:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(clearNativeData)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
