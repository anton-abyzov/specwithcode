import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type GitHubSignInState,
} from "@specweave-studio/contracts";
import { CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { gitHubSignIn } from "../../studio/gitHubSignIn";
import { Button } from "../ui/button";

const POLL_MS = 1_500;
const ACTIVE = new Set<GitHubSignInState["phase"]>(["starting", "waiting", "verifying"]);

/** gh shows the page without a scheme, which reads better than the full URL. */
const pageLabel = (url: string) => url.replace(/^https:\/\//u, "");

/**
 * Whether the panel shows for this machine: its server supports the flow and this
 * client may change its settings. Callers word their `gh auth login` hint by it.
 */
export function useGitHubSignInAvailable(environmentId: EnvironmentId): boolean {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment?.capabilities
      ?.gitHubSignIn === true;
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return supported && allowed;
}

/**
 * Signs the GitHub CLI in on another machine from this device: that machine runs
 * `gh auth login`, this panel shows its one-time code and opens GitHub's device page
 * here. The login is stored on that machine only; no token passes through this device.
 * Renders nothing when the machine's server predates it or this client may not change
 * that machine's settings, so callers keep their `gh auth login` hint.
 */
export function GitHubSignInPanel({
  environmentId,
  environmentLabel,
  onSignedIn,
  startLabel = "Sign in to GitHub",
  secondary = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onSignedIn?: () => void;
  /** The idle button's text, for when the code is the second choice. */
  readonly startLabel?: string;
  /** A quieter idle state: just the button, without the explanation. */
  readonly secondary?: boolean;
}) {
  const enabled = useGitHubSignInAvailable(environmentId);
  const options = { reportFailure: false } as const;
  const start = useAtomCommand(gitHubSignIn.start, options);
  const status = useAtomCommand(gitHubSignIn.status, options);
  const cancel = useAtomCommand(gitHubSignIn.cancel, options);
  const [flow, setFlow] = useState<GitHubSignInState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reported = useRef<string | null>(null);

  const apply = useCallback((result: Awaited<ReturnType<typeof status>>, fallback: string) => {
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error && cause.message ? cause.message : fallback);
      return;
    }
    setError(null);
    setFlow(result.value);
  }, []);

  // Pick up a sign-in already running there, from another window or before a reconnect.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void status({ environmentId, input: {} }).then((result) => {
      if (live && result._tag === "Success" && ACTIVE.has(result.value.phase))
        setFlow(result.value);
    });
    return () => {
      live = false;
    };
  }, [enabled, environmentId, status]);

  const phase = flow?.phase ?? "idle";
  // Polls while gh runs there; a failed read keeps polling, since the flow itself goes on.
  useEffect(() => {
    if (!ACTIVE.has(phase)) return;
    let live = true;
    const timer = setInterval(() => {
      void status({ environmentId, input: {} }).then((result) => {
        if (live) apply(result, `Lost track of the sign-in on ${environmentLabel}.`);
      });
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [apply, environmentId, environmentLabel, phase, status]);

  useEffect(() => {
    if (flow?.phase !== "succeeded" || !flow.flowId || reported.current === flow.flowId) return;
    reported.current = flow.flowId;
    onSignedIn?.();
  }, [flow, onSignedIn]);

  if (!enabled) return null;

  const begin = async () => {
    setBusy(true);
    setCopied(null);
    try {
      apply(
        await start({ environmentId, input: {} }),
        `${environmentLabel} could not start the GitHub sign-in.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      apply(
        await cancel({ environmentId, input: flow?.flowId ? { flowId: flow.flowId } : {} }),
        `${environmentLabel} could not cancel the GitHub sign-in.`,
      );
    } finally {
      setBusy(false);
    }
  };
  const openPage = (url: string) =>
    ensureLocalApi()
      .shell.openExternal(url)
      .catch(() => setError(`Could not open ${pageLabel(url)}. Open it in your browser.`));

  const code = flow?.deviceCode ?? null;
  const signInButton = (label: string, variant: "outline" | "ghost" = "outline") => (
    <Button size="xs" variant={variant} disabled={busy} onClick={() => void begin()}>
      {label}
    </Button>
  );

  return (
    <div
      className="mt-1 grid min-w-0 gap-2 text-xs"
      data-slot="github-sign-in"
      data-phase={phase}
      aria-live="polite"
    >
      {phase === "idle" ? (
        secondary ? (
          <div>{signInButton(startLabel, "ghost")}</div>
        ) : (
          <>
            <p className="text-muted-foreground">
              Sign in from here: {environmentLabel} runs gh, you approve it on github.com in this
              browser. The sign-in stays on {environmentLabel}.
            </p>
            <div>{signInButton(startLabel)}</div>
          </>
        )
      ) : null}
      {phase === "starting" ? (
        <p className="text-muted-foreground">Starting gh on {environmentLabel}…</p>
      ) : null}
      {phase === "waiting" && code ? (
        <section
          aria-label={`GitHub sign-in for ${environmentLabel}`}
          className="grid min-w-0 gap-2 rounded-md border border-border bg-muted/30 p-3"
        >
          <p className="text-muted-foreground">
            Open {pageLabel(code.url)} on this device, enter this code and approve. The sign-in is
            saved on {environmentLabel} only.
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <code className="select-all font-mono text-lg font-semibold tracking-wider">
              {code.userCode}
            </code>
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void writeTextToClipboard(code.userCode, "GitHub sign-in code")
                  .then(() => setCopied(code.userCode))
                  .catch(() => setError("Could not copy the code. Select it and copy it."))
              }
            >
              <CopyIcon />
              Copy code
            </Button>
            {copied === code.userCode ? (
              <span role="status" className="text-muted-foreground">
                Code copied
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => void openPage(code.url)}>
              <ExternalLinkIcon />
              Open {pageLabel(code.url)}
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void stop()}>
              Cancel
            </Button>
          </div>
          <p className="text-muted-foreground">Waiting for GitHub to confirm…</p>
        </section>
      ) : null}
      {phase === "verifying" ? (
        <p className="text-muted-foreground">Checking the sign-in on {environmentLabel}…</p>
      ) : null}
      {phase === "succeeded" ? (
        <p role="status" className="text-success-foreground">
          {flow?.alreadySignedIn ? "Already signed in" : "Signed in"}
          {flow?.login ? ` as ${flow.login}` : ""} on {environmentLabel}.
        </p>
      ) : null}
      {phase === "failed" || phase === "cancelled" ? (
        <>
          <p role={phase === "failed" ? "alert" : "status"} className="wrap-anywhere">
            {flow?.failure === "not-installed"
              ? `The GitHub CLI is not installed on ${environmentLabel}. Run specwithcode provision on ${environmentLabel}, then try again.`
              : flow?.failure === "outdated"
                ? `The GitHub CLI on ${environmentLabel} is too old. Update gh on ${environmentLabel}, then sign in.`
                : (flow?.message ?? "The GitHub sign-in stopped.")}
          </p>
          <div>{signInButton("Retry")}</div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="wrap-anywhere text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
