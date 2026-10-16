import type { ProjectId, TelegramChannelStatus } from "@specweave-studio/contracts";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  TELEGRAM_BOT_TOKEN_PATTERN,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import { MessageCircleIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useProjects, useServerConfigs } from "../../state/entities";
import { projectPickerMembers } from "../../studio/projectListVisibility";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function pollingBadge(status: TelegramChannelStatus) {
  if (!status.enabled) return { label: "Off", variant: "secondary" as const };
  if (status.polling === "error")
    return { label: "Can't reach Telegram", variant: "error" as const };
  if (status.polling === "running") return { label: "Listening", variant: "success" as const };
  return { label: "Starting", variant: "info" as const };
}

export function MessagingSettingsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  const supported = config?.environment.capabilities.telegramChannel === true;
  const query = useEnvironmentQuery(
    environmentId === null || !canRead || !supported
      ? null
      : serverEnvironment.telegramChannelStatus({ environmentId, input: {} }),
  );
  const status = query.data ?? null;
  const configure = useAtomCommand(serverEnvironment.configureTelegramChannel, {
    reportFailure: false,
  });
  const unpair = useAtomCommand(serverEnvironment.unpairTelegramChannel, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.removeTelegramChannel, { reportFailure: false });

  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        // Personal projects first: they are the natural home for a phone agent.
        .toSorted(
          (left, right) =>
            Number(right.workspaceSettings?.kind === "personal") -
              Number(left.workspaceSettings?.kind === "personal") ||
            left.title.localeCompare(right.title),
        ),
    [allProjects, environmentId],
  );

  const [token, setToken] = useState("");
  // Drafts stay null until edited, so the form shows what the host has saved.
  const [projectDraft, setProjectId] = useState<ProjectId | null>(null);
  const [enabledDraft, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const projectId = projectDraft ?? status?.projectId ?? null;
  const enabled = enabledDraft ?? (status?.configured === true ? status.enabled : true);

  // While a code waits for the phone, re-read so the pairing shows up here.
  const waitingForPairing = status !== null && status.configured && !status.paired;
  const { refresh } = query;
  useEffect(() => {
    if (!waitingForPairing) return;
    const timer = window.setInterval(refresh, 3_000);
    return () => window.clearInterval(timer);
  }, [waitingForPairing, refresh]);

  const run = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title,
          description: failure instanceof Error ? failure.message : "The host refused the change.",
        });
        return false;
      }
      return true;
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const trimmedToken = token.trim();
  const tokenLooksValid = trimmedToken === "" || TELEGRAM_BOT_TOKEN_PATTERN.test(trimmedToken);
  const canSave =
    canWrite &&
    environmentId !== null &&
    projectId !== null &&
    tokenLooksValid &&
    (trimmedToken !== "" || status?.configured === true) &&
    !busy;

  const save = () => {
    if (environmentId === null || projectId === null) return;
    void run("Could not save the Telegram channel", () =>
      configure({
        environmentId,
        input: {
          projectId,
          enabled,
          ...(trimmedToken === "" ? {} : { botToken: trimmedToken }),
        },
      }),
    ).then((ok) => {
      if (ok) setToken("");
    });
  };

  const deepLink =
    status?.botUsername && status.pairingCode
      ? `https://t.me/${status.botUsername}?start=${status.pairingCode}`
      : null;
  const badge = status ? pollingBadge(status) : null;
  const selectedProject = projects.find((project) => project.id === projectId);
  // The channel's own project stays a choice even once archived.
  const projectChoices = projectPickerMembers(
    projects,
    (id) => configs.get(id)?.scratchWorkspaceRoot ?? null,
    selectedProject ?? null,
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Telegram"
        icon={<MessageCircleIcon className="size-4" />}
        id="messaging"
        headerAction={
          badge && status?.configured ? (
            <Badge variant={badge.variant}>{badge.label}</Badge>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1 px-3 py-3 text-muted-foreground text-sm sm:px-4">
          <p>
            Talk to a project&apos;s coordinator from your phone, like a personal agent. Messages
            you send become work for the coordinator on this machine, and its answers, your
            routines&apos; results and waiting approvals come back to the chat.
          </p>
          <p className="text-xs">
            This machine calls Telegram; nothing on it is opened to the internet. Only the one chat
            that sends the pairing code can reach the coordinator, and approvals still happen in
            SpecWithCode. Answers arrive while this machine is awake.
          </p>
        </div>

        {config !== undefined && !supported ? (
          <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
            The SpecWithCode service this app is connected to (version{" "}
            {config.environment.serverVersion}) is older than the Telegram channel. Update that
            service to use it.
          </p>
        ) : null}
        {query.error ? (
          <p className="px-3 py-3 text-destructive-foreground text-sm sm:px-4">{query.error}</p>
        ) : null}

        {supported ? (
          <div className="flex flex-col gap-4 border-t px-3 py-4 sm:px-4">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium text-sm">Bot token</span>
              <Input
                size="sm"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Telegram bot token"
                placeholder={
                  status?.configured
                    ? `Saved for @${status.botUsername ?? "your bot"}. Paste a new token to replace it.`
                    : "123456789:AA..."
                }
                value={token}
                disabled={!canWrite || busy}
                onChange={(event) => setToken(event.target.value)}
              />
              <span className="text-muted-foreground text-xs">
                {tokenLooksValid
                  ? "In Telegram, message @BotFather, send /newbot and paste the token it gives you. It stays on this machine."
                  : "That does not look like a bot token. It has digits, a colon, then letters."}
              </span>
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="font-medium text-sm">Project</span>
              <Select
                value={projectId}
                onValueChange={(value) => setProjectId(value as ProjectId | null)}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Project for the Telegram channel"
                  className="max-w-sm"
                >
                  <SelectValue>
                    {() =>
                      selectedProject
                        ? `${selectedProject.title}${selectedProject.workspaceSettings?.kind === "personal" ? " (personal)" : ""}`
                        : "Choose a project"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {projectChoices.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                      {project.workspaceSettings?.kind === "personal" ? " (personal)" : ""}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <span className="text-muted-foreground text-xs">
                Messages go to this project&apos;s coordinator. A personal assistant works best for
                everyday errands; a code project works for checking on builds from your phone.
              </span>
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="font-medium text-sm">On</span>
                <span className="text-muted-foreground text-xs">
                  Off stops listening; the pairing is kept.
                </span>
              </div>
              <Switch
                size="sm"
                checked={enabled}
                disabled={!canWrite || busy}
                aria-label="Telegram channel on"
                onCheckedChange={setEnabled}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!canSave} onClick={save}>
                {status?.configured ? "Save" : "Connect bot"}
              </Button>
              {status?.paired ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite || busy || environmentId === null}
                  onClick={() => {
                    if (environmentId === null) return;
                    void run("Could not unpair", () => unpair({ environmentId, input: {} }));
                  }}
                >
                  Unpair chat
                </Button>
              ) : null}
              {status?.configured ? (
                <Button
                  size="sm"
                  variant="destructive-outline"
                  disabled={!canWrite || busy || environmentId === null}
                  onClick={() => {
                    if (environmentId === null) return;
                    void run("Could not remove the channel", () =>
                      remove({ environmentId, input: {} }),
                    );
                  }}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {status?.configured && status.paired ? (
          <div className="flex flex-col gap-1 border-t px-3 py-3 text-sm sm:px-4">
            <span>
              Paired with <span className="font-medium">{status.chatLabel ?? "your chat"}</span>
              {status.botUsername ? ` through @${status.botUsername}` : ""}.
            </span>
            {status.lastError ? (
              <span className="text-destructive-foreground text-xs">{status.lastError}</span>
            ) : null}
          </div>
        ) : null}

        {status?.configured && !status.paired ? (
          <div className="flex flex-col gap-3 border-t px-3 py-4 sm:flex-row sm:items-center sm:px-4">
            {deepLink ? (
              <div className="shrink-0 rounded-md bg-white p-2">
                <QRCodeSvg value={deepLink} size={128} title="Open the bot in Telegram" />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Pair your phone</span>
              {status.pairingCode ? (
                <>
                  <span className="text-muted-foreground">
                    Scan the code with your phone, or open{" "}
                    {deepLink ? (
                      <a className="underline" href={deepLink} target="_blank" rel="noreferrer">
                        @{status.botUsername}
                      </a>
                    ) : (
                      "your bot"
                    )}{" "}
                    and send:
                  </span>
                  <span className="font-mono text-base tracking-wider">
                    /start {status.pairingCode}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    The code works once and expires in 30 minutes. This page updates when the chat
                    pairs.
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  The pairing code expired. Press Save to get a new one.
                </span>
              )}
            </div>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
