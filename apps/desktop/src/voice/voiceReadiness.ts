import type { DesktopVoiceStatus } from "@specweave-studio/contracts";

/** Do not open the microphone until on-device speech is actually ready. */
export async function prepareVoiceCall(
  status: DesktopVoiceStatus,
  prepare: () => Promise<unknown>,
): Promise<DesktopVoiceStatus> {
  if (!status.supported || status.microphone !== "granted") return status;
  try {
    await prepare();
    return status;
  } catch (error) {
    return {
      ...status,
      supported: false,
      reason:
        error instanceof Error
          ? error.message
          : "On-device speech could not get ready. Try again or type your message.",
    };
  }
}
