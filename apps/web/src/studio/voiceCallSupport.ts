import type { DesktopBridge } from "@specweave-studio/contracts";

import { isElectron } from "../env";

function currentBridge(): DesktopBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

/**
 * Voice runs on Apple's on-device speech in the Mac app and on whisper.cpp and
 * Piper in the Linux app. Browsers, phones and the Windows app get no controls
 * at all rather than a button that can never work. A desktop build too old to
 * report its platform keeps the earlier check, where the main process answers
 * that it is unsupported.
 */
export function canHostVoiceCall(bridge: DesktopBridge | undefined = currentBridge()): boolean {
  if (!isElectron || !bridge?.getVoiceStatus) return false;
  const platform = bridge.getClientPlatform?.();
  return platform === undefined || platform === "darwin" || platform === "linux";
}

export function isLinuxVoiceHost(bridge: DesktopBridge | undefined = currentBridge()): boolean {
  return bridge?.getClientPlatform?.() === "linux";
}

/** How voice copy names the machine doing the speech work. */
export function voiceHostName(bridge: DesktopBridge | undefined = currentBridge()): string {
  return isLinuxVoiceHost(bridge) ? "this computer" : "this Mac";
}
