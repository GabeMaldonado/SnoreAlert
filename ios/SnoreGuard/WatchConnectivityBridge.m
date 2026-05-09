#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(WatchConnectivityBridge, NSObject)

RCT_EXTERN_METHOD(startWatchSession)
RCT_EXTERN_METHOD(stopWatchSession)
RCT_EXTERN_METHOD(sendVibrateCommand)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
