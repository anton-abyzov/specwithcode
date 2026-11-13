import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { useAtomValue } from "@effect/atom-react";
import { usesChatGptSharing } from "@specweave-studio/shared/usageLimits";
import { useSyncExternalStore } from "react";
import { environmentPresentations } from "../../state/presentation";
import { useMachineNicknames } from "../../studio/machineNickname";
import { OpenAI } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { ChatGptUsageButton } from "./ChatGptUsageButton";
import {
  acknowledgeChatGptProfile,
  readAcknowledgedChatGptProfiles,
  readPendingChatGptSignIns,
  subscribeChatGptWelcome,
  type PendingChatGptSignIn,
} from "./chatGptWelcomeState";

let version = 0;
const getVersion = () => version;
const subscribe = (listener: () => void) =>
  subscribeChatGptWelcome(() => {
    version += 1;
    listener();
  });

export interface ChatGptWelcomeProfile {
  readonly key: string;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly environmentLabel: string;
  readonly providerName: string;
}

/**
 * The welcome is for a sign-in this window started: a ChatGPT profile that is
 * connected on some machine is not enough, because another machine's sign-in
 * (or a synced or refreshed snapshot) also connects it here.
 */
export function selectChatGptWelcome(
  profiles: readonly ChatGptWelcomeProfile[],
  pending: readonly PendingChatGptSignIn[],
  acknowledged: readonly string[],
): ChatGptWelcomeProfile | undefined {
  return profiles.find(
    (profile) =>
      !acknowledged.includes(profile.key) &&
      pending.some(
        (entry) =>
          entry.environmentId === profile.environmentId && entry.instanceId === profile.instanceId,
      ),
  );
}

/** Read the verified environment snapshot, never the browser callback acknowledgment. */
export function ChatGptWelcomeCoordinator() {
  const tx = useTx();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const nickname = useMachineNicknames();
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const profiles = [...presentations].flatMap(([environmentId, presentation]) =>
    presentation.connection.phase !== "connected"
      ? []
      : (presentation.serverConfig?.providers ?? []).filter(usesChatGptSharing).map((provider) => ({
          key: JSON.stringify([
            environmentId,
            provider.instanceId,
            provider.auth.profileId ?? provider.auth.email ?? "default",
          ]),
          environmentId: String(environmentId),
          instanceId: String(provider.instanceId),
          environmentLabel: nickname(environmentId, presentation.entry.target.label),
          providerName: provider.displayName ?? "Codex",
        })),
  );
  const next = selectChatGptWelcome(
    profiles,
    readPendingChatGptSignIns(),
    readAcknowledgedChatGptProfiles(),
  );
  const dismiss = () => {
    if (!next) return;
    acknowledgeChatGptProfile(next.key, next.environmentId, next.instanceId);
  };
  return (
    <Dialog
      open={next !== undefined}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <OpenAI className="mb-2 size-8" aria-hidden="true" />
          <DialogTitle>{tx("Your ChatGPT plan is connected")}</DialogTitle>
          <DialogDescription>
            {tx(
              "Eligible usage in SpecWithCode uses your ChatGPT plan. Manage your shared usage and any credit settings in ChatGPT.",
            )}
          </DialogDescription>
          <p className="text-xs text-muted-foreground">
            {renderRich(tx("{providerName} on {environmentLabel}"), {
              providerName: next?.providerName,
              environmentLabel: next?.environmentLabel,
            })}
          </p>
        </DialogHeader>
        <DialogFooter>
          <ChatGptUsageButton />
          <Button onClick={dismiss}>{tx("Continue")}</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
