import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  PreviewRuntime,
  PreviewSessionSnapshot,
} from "@specweave-studio/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
  useServerConfigs,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  return readEnvironmentSupportsServerBrowser(environmentId) ? "server" : undefined;
}

/** Electron hosts its own browser tabs; other clients need the environment to host them. */
export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

/**
 * Whether this client draws a server tab with its own `<webview>`. The desktop
 * app renders tabs of the server it launched, which drives them over the
 * desktop browser channel; every other client and environment streams them.
 *
 * An installed service the desktop only attached to has no channel, so it
 * drives a page of its own. Drawing a webview there would show the user a
 * second, undriven copy of the tab, signed in with different cookies.
 */
export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
  hasDesktopBrowserChannel: boolean,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId &&
    hasDesktopBrowserChannel
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): boolean {
  const configs = useServerConfigs();
  return rendersServerTabNatively(
    environmentId,
    useAtomValue(primaryEnvironmentIdAtom),
    snapshot,
    // The desktop always launches a server of its own build, so a missing flag
    // means a service it attached to, never one it drives.
    configs.get(environmentId)?.environment.capabilities.desktopBrowserChannel === true,
  );
}
