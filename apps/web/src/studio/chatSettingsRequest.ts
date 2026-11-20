import type { EnvironmentId, ScopedThreadRef } from "@specweave-studio/contracts";
import { create } from "zustand";

/**
 * A chat started without a project. It has no project settings: it lives in a
 * folder of its own on one machine and shares no goal, memory or coordinator with
 * other chats. `threadRef` is null for an unsent draft, which has no thread yet.
 */
export interface ChatSettingsRequest {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
}

/** The open Chat settings request; the dialog lives in components/chat/ChatSettingsDialog. */
export const useChatSettingsRequest = create<{ request: ChatSettingsRequest | null }>(() => ({
  request: null,
}));

/** Opens Chat settings over the page in view; it never navigates. */
export function requestChatSettings(request: ChatSettingsRequest): void {
  useChatSettingsRequest.setState({ request });
}

export function closeChatSettings(): void {
  useChatSettingsRequest.setState({ request: null });
}
