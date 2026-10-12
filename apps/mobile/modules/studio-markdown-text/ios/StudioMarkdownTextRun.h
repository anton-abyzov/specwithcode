// This guard prevent this file to be compiled in the old architecture.
#ifdef RCT_NEW_ARCH_ENABLED
#import <React/RCTViewComponentView.h>
#import <React/RCTComponent.h>
#import <UIKit/UIKit.h>

#ifndef StudioMarkdownTextRunNativeComponent_h
#define StudioMarkdownTextRunNativeComponent_h

NS_ASSUME_NONNULL_BEGIN

@interface StudioMarkdownTextRun : RCTViewComponentView

@property (nonatomic, copy, nullable) NSString *text;
@property (nonatomic, assign) BOOL contextChipInteractive;

- (nullable UIMenu *)contextMenu;
- (BOOL)hasContextMenu;
- (void)onContextMenuAction:(NSString *)actionIdentifier;
- (void)onPress;
- (void)onLongPress;

@end

NS_ASSUME_NONNULL_END

#endif /* UitextviewViewNativeComponent_h */
#endif /* RCT_NEW_ARCH_ENABLED */
