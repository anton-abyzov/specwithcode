import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useAideEnabled } from "../../hooks/useSettings";
import { readEnvironmentSupportsProjectMove, useThreadShell } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import {
  type ChatSettingsRequest,
  closeChatSettings,
  useChatSettingsRequest,
} from "../../studio/chatSettingsRequest";
import { useMachineNicknames } from "../../studio/machineNickname";
import { requestSwitchModel } from "../handoff/HandOffThreadDialog";
import { ModelBadge, useProviderEntries } from "../studio/shell/ModelBadge";
import { requestThreadMove } from "../ThreadMoveDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export const CHAT_SETTINGS_LEAD =
  "This chat has no project, so it shares nothing with other chats: no goal, memory or coordinator. Move it to a project when it should share that project's context.";

export function ChatSettingsDialogHost() {
  const request = useChatSettingsRequest((state) => state.request);
  // A request belongs to the page it was made on, like Project settings over a page.
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => closeChatSettings, [pathname]);
  return request ? (
    <ChatSettingsDialog
      key={`${request.environmentId}:${request.threadRef?.threadId ?? "draft"}`}
      request={request}
    />
  ) : null;
}

function ChatSettingsDialog({ request }: { readonly request: ChatSettingsRequest }) {
  const { environmentId, threadRef } = request;
  const thread = useThreadShell(threadRef);
  const environment = useEnvironment(environmentId);
  const nameOf = useMachineNicknames();
  const entries = useProviderEntries(environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: "folder path" });
  const machine = nameOf(environmentId, environment?.label ?? null);
  const folder = thread?.worktreePath ?? null;
  const model = thread?.modelSelection ?? null;
  const canMove =
    threadRef !== null &&
    thread !== null &&
    canOperate &&
    readEnvironmentSupportsProjectMove(environmentId);
  const canSwitch = threadRef !== null && thread !== null && canOperate;
  const assistant = useAideEnabled();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) closeChatSettings();
      }}
    >
      <DialogPopup className="sm:max-w-lg" data-chat-settings="">
        <DialogHeader>
          <DialogTitle>Chat settings</DialogTitle>
          <DialogDescription>{thread?.title ?? "New chat"}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">{CHAT_SETTINGS_LEAD}</p>
            <dl className="flex flex-col divide-y rounded-lg border text-sm">
              <ChatSettingsRow label="Machine">
                <span>{machine}</span>
              </ChatSettingsRow>
              <ChatSettingsRow label="Folder">
                {folder ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <code className="min-w-0 truncate font-mono text-xs">{folder}</code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => copyToClipboard(folder)}
                    >
                      {isCopied ? "Copied" : "Copy"}
                    </Button>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {threadRef === null
                      ? "Its own folder is made when you send the first message."
                      : "Its own folder on this machine."}
                  </span>
                )}
              </ChatSettingsRow>
              <ChatSettingsRow label="Model">
                {model ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <ModelBadge
                      entry={entries.get(model.instanceId) ?? null}
                      instanceId={model.instanceId}
                      model={model.model}
                      variant="chip"
                    />
                    {canSwitch ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          closeChatSettings();
                          requestSwitchModel(threadRef);
                        }}
                      >
                        Switch model…
                      </Button>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Chosen in the message box.</span>
                )}
              </ChatSettingsRow>
            </dl>
            {assistant ? (
              <p className="text-xs text-muted-foreground">
                Facts about you belong with your personal assistant, which keeps them across your
                machines.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {canMove ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                closeChatSettings();
                void requestThreadMove(threadRef);
              }}
            >
              Move to project…
            </Button>
          ) : null}
          <Button type="button" onClick={() => closeChatSettings()}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ChatSettingsRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 px-3 py-2.5">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 items-center">{children}</dd>
    </div>
  );
}
