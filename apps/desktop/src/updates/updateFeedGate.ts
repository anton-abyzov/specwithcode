// @effect-diagnostics nodeBuiltinImport:off -- Update feed names are compared by SHA-256 digest.
import * as NodeCrypto from "node:crypto";

/** Whether this build may update itself, and from which feed (DesktopUpdates reads both). */

export function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
  feedIsUpstream?: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.feedIsUpstream) {
    return "Automatic updates are off because this build points at a feed SpecWithCode does not own.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the SPECWITHCODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

// Studio never updates itself from the product it was forked from. That
// product's feed owner, repository and update host are matched by SHA-256, so
// this file does not carry their names.
const UPSTREAM_UPDATE_FEED_DIGESTS = new Set([
  "546cf27bd3d20c268891bbd859d84c1da67bc9e44cb1988bbfc6f72c2a6d16f9",
  "8a8157f91757ad646fd8615fd9718e37f96c9c60a38f894b075cc1e0c499e24a",
  "f72ae0c9ef66c9b28790fadd7e6725ab38a5c5d59470f286ff0720eecf36ae00",
  "e6c67ade29a30e00ac361616629808bf30a61556535a7be8a41b63934ba0efe1",
]);

// Each word of the value, and each dot suffix of a dotted word, so that a host
// such as updates.example.com is compared as example.com too.
function updateFeedTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .flatMap((word) => word.split(".").map((_, index, parts) => parts.slice(index).join(".")))
    .filter((term) => term !== "");
}

export function isUpstreamUpdateFeed(
  config: Readonly<Record<string, string>> | undefined,
): boolean {
  if (config === undefined) return false;
  return [config.owner, config.repo, config.url].some(
    (value) =>
      typeof value === "string" &&
      updateFeedTerms(value).some((term) =>
        UPSTREAM_UPDATE_FEED_DIGESTS.has(
          NodeCrypto.createHash("sha256").update(term).digest("hex"),
        ),
      ),
  );
}
