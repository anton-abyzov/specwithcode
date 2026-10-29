/** Shared content gate; execution metadata alone is not an assistant response. */
export function isMetadataOnlyAssistantMessage(
  message: {
    readonly role: string;
    readonly text: string;
    readonly streaming?: boolean | undefined;
    readonly attachments?: readonly unknown[] | undefined;
  },
  hasSupplementalContent = false,
): boolean {
  return (
    message.role === "assistant" &&
    !message.streaming &&
    !message.text.trim() &&
    !message.attachments?.length &&
    !hasSupplementalContent
  );
}
