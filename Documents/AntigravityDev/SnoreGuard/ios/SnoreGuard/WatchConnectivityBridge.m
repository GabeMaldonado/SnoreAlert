#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(WatchConnectivityBridge, NSObject)

RCT_EXTERN_METHOD(sendVibrateCommand)
RCT_EXTERN_METHOD(startWatchSession)
RCT_EXTERN_METHOD(stopWatchSession)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
