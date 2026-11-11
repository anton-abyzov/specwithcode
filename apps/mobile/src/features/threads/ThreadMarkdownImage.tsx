import type { AssetResource, EnvironmentId } from "@specweave-studio/contracts";
import { createContext, useContext, useEffect, useId, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { MediaActionsMenu } from "../../components/MediaActionsMenu";
import { PresentationSource } from "../../components/NativePresentation";
import { useMediaActions } from "../../state/mediaActions";
import { type MediaActionsSource } from "../../lib/mediaActionsSource";
import { useAssetUrlState } from "../../state/assets";
import {
  MARKDOWN_IMAGE_MAX_WIDTH,
  type MarkdownImageDisplaySize,
  resolveMarkdownImageDisplaySize,
} from "./markdownImageSize";

/**
 * Width the feed lays markdown out in. The feed already knows this from its
 * viewport, so an image can size its frame on the first render instead of
 * waiting for its own onLayout, which would change the row's height once
 * more after the list has positioned the rows below it. It is an upper
 * bound: a list item or blockquote indents its column, and the measured
 * width takes over once it is known.
 */
export const MarkdownImageAvailableWidthContext = createContext(0);

export function ThreadMarkdownImageView(props: {
  readonly uri: string | null;
  readonly sourceKey: string;
  readonly unavailable: boolean;
  readonly alt: string | null;
  /** Pixel size from the server, when it could read the header; the frame is final from the first render. */
  readonly knownSize?: { readonly width: number; readonly height: number } | undefined;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const sourceIdentifier = useId();
  const mediaActions = useMediaActions(props.actionsSource);
  const contextWidth = useContext(MarkdownImageAvailableWidthContext);
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const availableWidth =
    measuredWidth > 0 && contextWidth > 0
      ? Math.min(contextWidth, measuredWidth)
      : contextWidth || measuredWidth;
  const [decodedSize, setDecodedSize] = useState<{ width: number; height: number } | null>(null);
  const [failedUri, setFailedUri] = useState<string | null>(null);

  useEffect(() => {
    setDecodedSize(null);
  }, [props.sourceKey]);

  useEffect(() => {
    setFailedUri(null);
  }, [props.uri]);

  // The decoded size is what the platform actually drew, so it wins over the
  // server's header hint once it exists.
  const sourceSize = decodedSize ?? props.knownSize ?? null;
  const displaySize: MarkdownImageDisplaySize | null =
    sourceSize === null || availableWidth <= 0
      ? null
      : resolveMarkdownImageDisplaySize({
          sourceWidth: sourceSize.width,
          sourceHeight: sourceSize.height,
          availableWidth,
        });
  const failed = props.unavailable || (props.uri !== null && failedUri === props.uri);
  const placeholderWidth: ViewStyle["width"] =
    availableWidth > 0 ? Math.min(availableWidth, MARKDOWN_IMAGE_MAX_WIDTH) : "100%";
  const frameStyle: ViewStyle = displaySize ?? { width: placeholderWidth, aspectRatio: 16 / 9 };

  return (
    <View
      onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
      style={{ alignSelf: "stretch", gap: 6 }}
    >
      {props.uri === null || failed ? (
        <MediaActionsMenu media={mediaActions}>
          <Pressable
            accessibilityRole="imagebutton"
            accessibilityLabel={props.alt ?? "Markdown image"}
            accessibilityHint={
              mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
            }
            className="items-center justify-center rounded-[10px] bg-md-code-bg"
            style={frameStyle}
          >
            {failed ? (
              <Text className="text-xs text-foreground-muted">Image unavailable</Text>
            ) : (
              <ActivityIndicator />
            )}
          </Pressable>
        </MediaActionsMenu>
      ) : (
        <PresentationSource identifier={sourceIdentifier} style={{ alignSelf: "flex-start" }}>
          <MediaActionsMenu media={mediaActions}>
            <Pressable
              accessibilityRole="imagebutton"
              accessibilityLabel={props.alt ?? "Markdown image"}
              accessibilityHint={
                mediaActions.actions.length > 0 ? "Touch and hold for media actions" : undefined
              }
              onPress={() =>
                props.onPressPreview({
                  kind: "image",
                  uri: props.uri!,
                  name: props.actionsSource?.name ?? props.alt ?? "Image",
                  sourceIdentifier,
                  actionsSource: props.actionsSource,
                })
              }
              style={{ alignSelf: "flex-start" }}
            >
              <View
                className="items-center justify-center overflow-hidden rounded-[10px] bg-md-code-bg"
                style={frameStyle}
              >
                <ThreadMarkdownImageRequest
                  key={props.uri}
                  uri={props.uri}
                  onLoad={setDecodedSize}
                  onError={() => setFailedUri(props.uri)}
                />
              </View>
            </Pressable>
          </MediaActionsMenu>
        </PresentationSource>
      )}
      {props.alt ? (
        <Text selectable className="text-xs text-foreground-muted">
          {props.alt}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadMarkdownImageRequest(props: {
  readonly uri: string;
  readonly onLoad: (sourceSize: { width: number; height: number }) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <>
      <Image
        source={{ uri: props.uri }}
        resizeMode="contain"
        accessible={false}
        onLoad={(event) => {
          setLoaded(true);
          props.onLoad(event.nativeEvent.source);
        }}
        onError={props.onError}
        style={{ width: "100%", height: "100%", opacity: loaded ? 1 : 0 }}
      />
      {loaded ? null : (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}
        >
          <Text className="text-xs text-foreground-muted">Loading image…</Text>
        </View>
      )}
    </>
  );
}

/** Environment-hosted image that loads through a signed asset URL. */
export function ThreadMarkdownImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<
    AssetResource,
    { readonly _tag: "attachment" | "media-file" | "tool-output-image" }
  >;
  readonly alt: string | null;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource);

  return (
    <ThreadMarkdownImageView
      uri={assetUrl._tag === "Success" ? assetUrl.url + (props.srcFragment ?? "") : null}
      sourceKey={
        props.resource._tag === "attachment"
          ? `attachment:${props.resource.attachmentId}`
          : props.resource._tag === "tool-output-image"
            ? `tool-output:${props.resource.itemId}:${props.resource.index}`
            : `workspace:${props.resource.path}`
      }
      unavailable={assetUrl._tag === "Failure"}
      knownSize={assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined}
      alt={props.alt}
      actionsSource={props.actionsSource}
      onPressPreview={props.onPressPreview}
    />
  );
}

/**
 * The first image a message names only by path, as one thumbnail under the
 * message. It loads a downscaled copy through the thread's server, so a phone
 * on Connect does not download a full screenshot to show a small picture; a
 * tap opens the file itself. Nothing renders when the file cannot be signed,
 * so a moved or foreign path leaves the chip alone.
 */
export function ThreadMediaFallbackImage(props: {
  readonly environmentId: EnvironmentId;
  readonly resource: Extract<AssetResource, { readonly _tag: "media-file" }>;
  readonly name: string;
  /** The full file, for the expanded viewer. */
  readonly previewSource: FilePreviewSource;
  readonly actionsSource?: MediaActionsSource;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const assetUrl = useAssetUrlState(props.environmentId, props.resource, "thumb");
  if (assetUrl._tag === "Failure") return null;
  return (
    <View testID="thread-media-fallback" style={{ marginTop: 8 }}>
      <ThreadMarkdownImageView
        uri={assetUrl._tag === "Success" ? assetUrl.url : null}
        sourceKey={`fallback:${props.resource.path}`}
        unavailable={false}
        knownSize={assetUrl._tag === "Success" ? assetUrl.imageDimensions : undefined}
        alt={props.name}
        actionsSource={props.actionsSource}
        onPressPreview={() => props.onPressPreview(props.previewSource)}
      />
    </View>
  );
}

export function ThreadMarkdownImageUnavailable(props: { readonly alt: string | null }) {
  return (
    <ThreadMarkdownImageView
      uri={null}
      sourceKey="unavailable"
      unavailable
      alt={props.alt}
      onPressPreview={() => undefined}
    />
  );
}
