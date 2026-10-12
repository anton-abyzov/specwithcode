#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "Utils.h"

@interface StudioMarkdownTextManager : RCTViewManager
@end

@implementation StudioMarkdownTextManager

RCT_EXPORT_MODULE(StudioMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface StudioMarkdownTextRunManager : RCTViewManager
@end

@implementation StudioMarkdownTextRunManager

RCT_EXPORT_MODULE(StudioMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
