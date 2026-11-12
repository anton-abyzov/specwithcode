import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import type { EnvironmentId, ProjectId, TelegramChannelStatus } from "@specweave-studio/contracts";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  PERSONAL_ASSISTANT_LABEL,
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
import {
  ineligibleProjectLabel,
  ineligibleSelectedMember,
  projectPickerMembers,
} from "../../studio/projectListVisibility";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAideEnabled } from "../../hooks/useSettings";
import { visibleWithAideKeeping } from "../../studio/personalAssistant";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { teamRulesToolLock } from "../../teamRules/teamRulesView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { TeamRulesInert, TeamRulesLockNote } from "./TeamRulesLock";

function pollingBadge(status: TelegramChannelStatus) {
  if (!status.enabled) return { label: "Off", variant: "secondary" as const };
  if (status.polling === "error")
    return { label: "Can't reach Telegram", variant: "error" as const };
  if (status.polling === "running") return { label: "Listening", variant: "success" as const };
  return { label: "Starting", variant: "info" as const };
}

export function MessagingSettingsPanel() {
  const tx = useTx();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  // Unpair and Remove stay outside the lock below, so the channel can always be taken away.
  const teamRulesLock = teamRulesToolLock(config?.teamRules, "telegram");
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

  const [token, setToken] = useState("");
  // Drafts stay null until edited, so the form shows what the host has saved.
  const [projectDraft, setProjectId] = useState<ProjectId | null>(null);

  const allProjects = useProjects();
  // A hidden personal assistant (Settings → General) is not offered, but the one
  // the channel already uses stays listed so nothing changes on its own.
  const aideEnabled = useAideEnabled();
  const savedProjectId = status?.projectId ?? null;
  const projects = useMemo(
    () =>
      visibleWithAideKeeping(
        allProjects.filter((project) => project.environmentId === environmentId),
        aideEnabled,
        [savedProjectId, projectDraft],
      )
        // Aide first: it is the natural home for a phone agent.
        .toSorted(
          (left, right) =>
            Number(right.workspaceSettings?.kind === "personal") -
              Number(left.workspaceSettings?.kind === "personal") ||
            left.title.localeCompare(right.title),
        ),
    [aideEnabled, allProjects, environmentId, projectDraft, savedProjectId],
  );
  const [enabledDraft, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const projectId = projectDraft ?? status?.projectId ?? null;
  const enabled = enabledDraft ?? (status?.configured === true ? status.enabled : true);
  const selectedProject = projects.find((project) => project.id === projectId);
  const scratchRootFor = (id: EnvironmentId) => configs.get(id)?.scratchWorkspaceRoot ?? null;
  // Only the person's own projects are choices. A channel whose project was since archived
  // or made by a check shows it apart: saving needs another project, unless the channel is
  // turned off, so no work goes there.
  const projectChoices = projectPickerMembers(projects, scratchRootFor, { purpose: "any" });
  const unavailableProject = ineligibleSelectedMember(
    projects,
    selectedProject,
    scratchRootFor,
    "any",
  );

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
    (unavailableProject === null || !enabled) &&
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

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={tx("Telegram")}
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
            {tx(
              "Talk to a project's coordinator from your phone, like a personal agent. Messages you send become work for the coordinator on this machine, and its answers, your routines' results and waiting approvals come back to the chat.",
            )}
          </p>
          <p className="text-xs">
            {tx(
              "This machine calls Telegram; nothing on it is opened to the internet. Only the one chat that sends the pairing code can reach the coordinator, and approvals still happen in SpecWithCode. Answers arrive while this machine is awake.",
            )}
          </p>
          {teamRulesLock ? <TeamRulesLockNote lock={teamRulesLock} /> : null}
        </div>

        {config !== undefined && !supported ? (
          <p className="px-3 py-3 text-muted-foreground text-sm sm:px-4">
            {renderRich(
              tx(
                "The SpecWithCode service this app is connected to (version {serverVersion}) is older than the Telegram channel. Update that service to use it.",
              ),
              { serverVersion: config.environment.serverVersion },
            )}
          </p>
        ) : null}
        {query.error ? (
          <p className="px-3 py-3 text-destructive-foreground text-sm sm:px-4">{query.error}</p>
        ) : null}

        {supported ? (
          <div className="flex flex-col gap-4 border-t px-3 py-4 sm:px-4">
            <TeamRulesInert lock={teamRulesLock} className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="font-medium text-sm">{tx("Bot token")}</span>
                <Input
                  size="sm"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={tx("Telegram bot token")}
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
                    ? tx(
                        "In Telegram, message @BotFather, send /newbot and paste the token it gives you. It stays on this machine.",
                      )
                    : tx(
                        "That does not look like a bot token. It has digits, a colon, then letters.",
                      )}
                </span>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="font-medium text-sm">{tx("Project")}</span>
                <Select
                  value={projectId}
                  onValueChange={(value) => setProjectId(value as ProjectId | null)}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={tx("Project for the Telegram channel")}
                    className="max-w-sm"
                  >
                    <SelectValue>
                      {() => (selectedProject ? selectedProject.title : "Choose a project")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {unavailableProject ? (
                      <SelectItem value={unavailableProject.project.id} disabled>
                        {unavailableProject.project.title}
                        <span className="ms-2 text-muted-foreground text-xs">
                          {ineligibleProjectLabel(unavailableProject.reason)}
                        </span>
                      </SelectItem>
                    ) : null}
                    {projectChoices.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                        {project.workspaceSettings?.kind === "personal" ? (
                          <span className="ms-2 text-muted-foreground text-xs">
                            {tx(PERSONAL_ASSISTANT_LABEL)}
                          </span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <span className="text-muted-foreground text-xs">
                  {renderRich(
                    selectedProject?.workspaceSettings?.kind === "personal"
                      ? tx("{value}Messages go to Aide. {value2}")
                      : tx("{value}Messages go to this project's coordinator. {value2}"),
                    {
                      value: unavailableProject
                        ? tx(
                            "{reason}. Choose another project to save, or turn the channel off. ",
                            {
                              reason: tx(ineligibleProjectLabel(unavailableProject.reason)),
                            },
                          )
                        : null,
                      value2: tx(
                        aideEnabled
                          ? "A personal assistant works best for everyday errands; a code project works for checking on builds from your phone."
                          : "A code project works for checking on builds from your phone.",
                      ),
                    },
                  )}
                </span>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="font-medium text-sm">On</span>
                  <span className="text-muted-foreground text-xs">
                    {tx("Off stops listening; the pairing is kept.")}
                  </span>
                </div>
                <Switch
                  size="sm"
                  checked={enabled}
                  disabled={!canWrite || busy}
                  aria-label={tx("Telegram channel on")}
                  onCheckedChange={setEnabled}
                />
              </div>
            </TeamRulesInert>

            <div className="flex flex-wrap gap-2">
              <TeamRulesInert lock={teamRulesLock}>
                <Button size="sm" disabled={!canSave} onClick={save}>
                  {status?.configured ? tx("Save") : tx("Connect bot")}
                </Button>
              </TeamRulesInert>
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
                  {tx("Unpair chat")}
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
                  {tx("Remove")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {status?.configured && status.paired ? (
          <div className="flex flex-col gap-1 border-t px-3 py-3 text-sm sm:px-4">
            <span>
              {renderRich(tx("Paired with {span}{value}."), {
                span: <span className="font-medium">{status.chatLabel ?? tx("your chat")}</span>,
                value: status.botUsername ? tx(" through @{bot}", { bot: status.botUsername }) : "",
              })}
            </span>
            {status.lastError ? (
              <span className="text-destructive-foreground text-xs">{status.lastError}</span>
            ) : null}
          </div>
        ) : null}

        {status?.configured && !status.paired && teamRulesLock === null ? (
          <div className="flex flex-col gap-3 border-t px-3 py-4 sm:flex-row sm:items-center sm:px-4">
            {deepLink ? (
              <div className="shrink-0 rounded-md bg-white p-2">
                <QRCodeSvg value={deepLink} size={128} title={tx("Open the bot in Telegram")} />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">{tx("Pair your phone")}</span>
              {status.pairingCode ? (
                <>
                  <span className="text-muted-foreground">
                    {renderRich(tx("Scan the code with your phone, or open {value} and send:"), {
                      value: deepLink ? (
                        <a className="underline" href={deepLink} target="_blank" rel="noreferrer">
                          @{status.botUsername}
                        </a>
                      ) : (
                        "your bot"
                      ),
                    })}
                  </span>
                  <span className="font-mono text-base tracking-wider">
                    /start {status.pairingCode}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {tx(
                      "The code works once and expires in 30 minutes. This page updates when the chat pairs.",
                    )}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {tx("The pairing code expired. Press Save to get a new one.")}
                </span>
              )}
            </div>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
