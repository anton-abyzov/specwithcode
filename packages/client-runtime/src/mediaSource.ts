import type { AssetResource, ThreadId } from "@specweave-studio/contracts";
import { mediaMimeType, mediaMimeTypeFromExtension } from "@specweave-studio/shared/filePreview";

import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
  type MarkdownImageSource,
} from "./markdownImages.ts";
import {
  fileBasename,
  splitFilePathPosition,
  splitMarkdownLinkSearchAndHash,
} from "./markdownLinks.ts";
import {
  mediaFileReference,
  mediaReferenceFileName,
  mediaUrlReference,
  type MediaReference,
} from "./mediaReference.ts";

export type MediaSourceResource = Extract<AssetResource, { readonly _tag: "media-file" }>;

/** What a piece of authored media is and how its bytes can be reached. */
export type ResolvedMediaSource = {
  readonly kind: "image" | "video";
  readonly mimeType: string;
  readonly name: string;
  readonly reference?: MediaReference;
  readonly srcFragment: string;
} & (
  | {
      readonly access: "direct";
      readonly uri: string;
    }
  | {
      readonly access: "environment";
      readonly resource: MediaSourceResource;
    }
  | {
      readonly access: "unavailable";
    }
);

export interface ResolveMediaSourceInput {
  readonly threadId: ThreadId | undefined;
  readonly workspaceRoot?: string | null | undefined;
  readonly resolvedFilePath?: string | undefined;
  /**
   * Whether the source behind `resolvedFilePath` was written relative to the
   * workspace. The resolved path is absolute, so it no longer says so itself.
   */
  readonly resolvedFileRelative?: boolean | undefined;
  /** Image syntax can target an endpoint without a recognizable extension. */
  readonly imageEmbed?: boolean | undefined;
}

function classify(source: string, input: ResolveMediaSourceInput): MarkdownImageSource {
  if (input.resolvedFilePath === undefined) {
    return classifyMarkdownImageSource(source, input.workspaceRoot);
  }
  return {
    _tag: "WorkspaceFile",
    path: input.resolvedFilePath,
    ...(input.resolvedFileRelative ? { relative: true as const } : {}),
  };
}

/** Whether a media path was written relative to the thread's workspace. */
export function isWorkspaceRelativeMediaSource(source: string): boolean {
  const classified = classifyMarkdownImageSource(source, ".");
  return classified._tag === "WorkspaceFile" && classified.relative === true;
}

/**
 * The resource for a host file a message embeds. A relative path names the
 * thread's workspace, so only the thread's machine may serve it.
 */
export function markdownImageResource(
  threadId: ThreadId,
  source: Extract<MarkdownImageSource, { readonly _tag: "WorkspaceFile" }>,
): MediaSourceResource {
  return {
    _tag: "media-file",
    threadId,
    path: source.path,
    ...(source.relative ? { hostOnly: true as const } : {}),
  };
}

export function resolveMediaSource(
  source: string,
  input: ResolveMediaSourceInput,
): ResolvedMediaSource | null {
  const classified = classify(source, input);
  if (classified._tag === "Blocked") return null;

  const path =
    classified._tag === "Direct"
      ? splitMarkdownLinkSearchAndHash(classified.uri).path
      : splitFilePathPosition(classified.path).path;
  // Local paths have already been decoded. Do not interpret literal #, ?, or % characters again.
  const basename = fileBasename(path);
  const extensionIndex = basename.lastIndexOf(".");
  const detectedMimeType =
    classified._tag === "Direct"
      ? mediaMimeType(classified.uri)
      : extensionIndex < 0
        ? null
        : mediaMimeTypeFromExtension(basename.slice(extensionIndex));
  const mimeType = detectedMimeType ?? (input.imageEmbed ? "image/*" : null);
  if (mimeType === null) return null;
  const kind = mimeType.startsWith("video/") ? "video" : "image";

  const reference =
    classified._tag === "Direct"
      ? mediaUrlReference(classified.uri)
      : mediaFileReference(path, input.workspaceRoot);
  const name = (reference && mediaReferenceFileName(reference)) || basename || kind;
  const common = {
    kind,
    mimeType,
    name,
    ...(reference ? { reference } : {}),
    srcFragment: markdownImageSourceFragment(source),
  } as const;

  if (classified._tag === "Direct") {
    return { ...common, access: "direct", uri: classified.uri };
  }
  if (input.threadId === undefined) return { ...common, access: "unavailable" };
  return {
    ...common,
    access: "environment",
    resource: markdownImageResource(input.threadId, { ...classified, path }),
  };
}
