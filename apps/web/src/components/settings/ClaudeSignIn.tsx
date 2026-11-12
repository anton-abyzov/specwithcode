import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ProviderInstanceId,
  ServerProvider,
} from "@specweave-studio/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ClaudeAI } from "../Icons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { isClaudeSignInCode } from "./addClaudeAccount.logic";
import { SettingsRow } from "./settingsLayout";

const QUIET = { reportFailure: false, reportDefect: false } as const;

/**
 * Signs Claude Code in for one Claude agent, with no terminal. The machine runs
 * Claude Code's own sign-in; this shows where it stands. On the app's own
 * machine Claude Code opens the page itself and nothing is typed. From another
 * device the page opens here and gives a code to paste.
 */
export function ClaudeSignIn({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  os,
  command,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly os: ExecutionEnvironmentPlatformOs | undefined;
  /** The same sign-in as typed in a terminal, for those who want it. */
  readonly command: string;
  readonly readOnly?: boolean;
}) {
  const tx = useTx();
  // A new account has no sign-in to ask about until the machine lists it.
  const query = useEnvironmentQuery(
    provider === undefined
      ? null
      : serverEnvironment.providerAuthState({ environmentId, input: { instanceId } }),
  );
  const start = useAtomCommand(serverEnvironment.startProviderAuth, QUIET);
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, QUIET);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, QUIET);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, QUIET);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The app and Claude Code are on one machine: a browser opened there is seen.
  const here = window.desktopBridge !== undefined && environmentId === primaryEnvironmentId;
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<"link" | "command" | null>(null);
  const reservedTab = useRef<Window | null>(null);
  const openedFlow = useRef<string | null>(null);
  const leave = useRef(() => {});

  const auth = query.data;
  const signedIn = provider?.auth.status === "authenticated";
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const flowId = active ? (auth?.flowId ?? null) : null;
  const link =
    auth?.phase === "waiting" && auth.interaction?.type === "browser" ? auth.interaction.url : null;
  // A machine whose SpecWithCode cannot run the sign-in still has the command.
  const commandOnly = query.error !== null;
  // Another window started it: only that window can finish or cancel it.
  const elsewhere = active && flowId === null;
  const failed = !active && !signedIn && auth?.phase === "failed" ? auth.message : null;

  const dropReservedTab = () => {
    reservedTab.current?.close();
    reservedTab.current = null;
  };

  // From another device the page opens here, once for each sign-in.
  useEffect(() => {
    if (link === null || flowId === null || here || openedFlow.current === flowId) return;
    openedFlow.current = flowId;
    const tab = reservedTab.current;
    reservedTab.current = null;
    if (tab) tab.location.href = link;
    else if (window.desktopBridge)
      void ensureLocalApi()
        .shell.openExternal(link)
        .catch(() => {});
  }, [link, flowId, here]);

  useEffect(() => {
    if (auth?.phase === "failed" || auth?.phase === "cancelled") dropReservedTab();
    leave.current = () => {
      dropReservedTab();
      if (flowId !== null) void cancel({ environmentId, input: { instanceId, flowId } });
    };
  });

  // Leaving the sign-in stops Claude Code's sign-in process on the machine.
  useEffect(() => () => leave.current(), []);

  // Coming back from the browser or a terminal is the moment to look again.
  useEffect(() => {
    if (signedIn) return;
    const onFocus = () => void refresh({ environmentId, input: { instanceId } });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [signedIn, environmentId, instanceId, refresh]);

  async function run(command: () => Promise<AtomCommandResult<unknown, unknown>>) {
    setPending(true);
    setError(null);
    let succeeded = false;
    try {
      const result = await command();
      if (result._tag === "Success") succeeded = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : tx("Sign-in failed. Try again."));
      }
    } catch {
      setError(tx("Sign-in failed. Try again."));
    }
    setPending(false);
    return succeeded;
  }

  const signIn = () => {
    if (pending || readOnly) return;
    // A browser blocks a tab opened after a wait, so the web app takes one now.
    if (!here && !window.desktopBridge) {
      reservedTab.current = window.open("", "_blank");
      if (reservedTab.current) reservedTab.current.opener = null;
    }
    setCode("");
    void run(() =>
      start({
        environmentId,
        input: { instanceId, callbackMode: here ? "server" : "client" },
      }),
    ).then((started) => {
      if (!started) dropReservedTab();
    });
  };

  const sendCode = () => {
    if (pending || flowId === null) return;
    if (!isClaudeSignInCode(code)) {
      setError(
        tx(
          "That is not the whole code. Copy it from the page again: it has two parts joined by #.",
        ),
      );
      return;
    }
    void run(() =>
      complete({ environmentId, input: { instanceId, flowId, callbackUrl: code.trim() } }),
    ).then((sent) => {
      if (sent) setCode("");
    });
  };

  const copy = (text: string, what: "link" | "command") =>
    void writeTextToClipboard(text).then(
      () => setCopied(what),
      () => setError(tx("Could not copy. Select the text and copy it.")),
    );

  const check = async () => {
    if (checking) return;
    setChecking(true);
    await refresh({ environmentId, input: { instanceId } });
    setChecking(false);
  };

  const state = signedIn
    ? "signed-in"
    : commandOnly
      ? "command"
      : active
        ? (auth?.phase ?? "idle")
        : failed !== null
          ? "failed"
          : "idle";
  const account = provider?.auth.email?.trim() || provider?.auth.login?.trim();
  const description = signedIn
    ? [
        account ? tx("Signed in as {account}.", { account }) : tx("Signed in."),
        provider?.auth.label ? tx("Plan: {plan}.", { plan: provider.auth.label }) : null,
        tx("Its limits now show under Usage > Limits."),
      ]
        .filter((line) => line !== null)
        .join(" ")
    : commandOnly
      ? tx(
          "Run the command below once in a terminal on {machine}. It opens Claude's page in the browser.",
          { machine: environmentLabel },
        )
      : elsewhere
        ? tx("A sign-in for this account is in progress in another window.")
        : auth?.phase === "starting"
          ? tx("Starting Claude Code's sign-in…")
          : auth?.phase === "verifying"
            ? tx("Checking…")
            : link !== null
              ? tx("Sign in on the page that opened. If it shows a code, paste it here.")
              : tx("Claude's sign-in page opens in your browser. No terminal needed.");

  return (
    <div className="flex flex-col gap-3" data-claude-sign-in={state}>
      <SettingsRow
        literal
        title={link !== null ? tx("Finish in your browser") : tx("Account")}
        description={<span role="status">{description}</span>}
        status={
          (error ?? failed) ? (
            <p role="alert" className="[overflow-wrap:anywhere]">
              {error ?? failed}
            </p>
          ) : undefined
        }
        control={
          signedIn || commandOnly ? null : flowId !== null && auth?.phase !== "verifying" ? (
            <Button
              size="sm"
              variant="ghost-muted"
              aria-label={tx("Cancel sign-in")}
              disabled={pending}
              onClick={() =>
                void run(() => cancel({ environmentId, input: { instanceId, flowId } }))
              }
            >
              {tx("Cancel")}
            </Button>
          ) : active ? null : (
            <Button
              size="sm"
              disabled={pending || readOnly || auth === null || provider?.installed === false}
              onClick={signIn}
            >
              <ClaudeAI className="size-4 shrink-0" aria-hidden="true" />
              {failed !== null ? tx("Try again") : tx("Sign in with Claude")}
            </Button>
          )
        }
      >
        {link !== null ? (
          <div className="flex flex-col gap-2 py-2">
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                sendCode();
              }}
            >
              <Input
                aria-label={tx("Code from the page")}
                placeholder={tx("Code from the page")}
                autoComplete="off"
                spellCheck={false}
                value={code}
                disabled={pending}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" size="sm" disabled={pending || code.trim().length === 0}>
                {tx("Continue")}
              </Button>
            </form>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void ensureLocalApi()
                    .shell.openExternal(link)
                    .catch(() => setError(tx("Could not open the page. Copy the link.")))
                }
              >
                {tx("Open the page again")}
              </Button>
              <Button size="xs" variant="outline" onClick={() => copy(link, "link")}>
                {copied === "link" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
                {copied === "link" ? tx("Link copied") : tx("Copy the link")}
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsRow>
      {signedIn ? null : (
        <>
          <p className="px-3 text-xs text-muted-foreground sm:px-4">
            {tx("The Claude desktop app has its own sign-in, and it does not count here.")}
            {os === "windows"
              ? ` ${tx("A sign-in inside WSL or under another Windows user does not count either.")}`
              : null}
          </p>
          <details className="px-3 text-xs sm:px-4" open={commandOnly ? true : undefined}>
            <summary className="cursor-default text-muted-foreground">{tx("Show command")}</summary>
            <div className="mt-2 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
                {command}
              </code>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={copied === "command" ? tx("Copied") : tx("Copy command")}
                onClick={() => copy(command, "command")}
              >
                {copied === "command" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-2 text-muted-foreground">
              <span className="min-w-0 flex-1">
                {tx(
                  "After a sign-in in a terminal, the app checks again when you come back to this window.",
                )}
              </span>
              <Button size="xs" variant="outline" disabled={checking} onClick={() => void check()}>
                {checking ? tx("Checking…") : tx("Check sign-in")}
              </Button>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
