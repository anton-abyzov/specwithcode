import type { DesktopBridge } from "@specweave-studio/contracts";

import { isElectron } from "../env";

/**
 * Voice calls transcribe and speak through a macOS helper, so only the Mac app
 * can host one. Browsers, phones and the Windows and Linux apps get no call
 * controls at all rather than a button that can never work. A desktop build
 * too old to report its platform keeps the earlier check, where the main
 * process answers that it is unsupported.
 */
export function canHostVoiceCall(
  bridge: DesktopBridge | undefined = typeof window === "undefined"
    ? undefined
    : window.desktopBridge,
): boolean {
  if (!isElectron || !bridge?.getVoiceStatus) return false;
  const platform = bridge.getClientPlatform?.();
  return platform === undefined || platform === "darwin";
}
