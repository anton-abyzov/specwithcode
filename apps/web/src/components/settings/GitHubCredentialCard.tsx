import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type GitHubCredentialCopyPreview,
  type GitHubCredentialState,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { gitHubCredential } from "../../studio/gitHubCredentialCopy";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { describeToken, planGitHubCredential } from "./GitHubCredentialCard.logic";
import { GitHubSignInPanel, useGitHubSignInAvailable } from "./GitHubSignInPanel";

/** Whether this machine's server reports its GitHub access, and this client may change it. */
export function useGitHubCredentialCardAvailable(environmentId: EnvironmentId): boolean {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment?.capabilities
      ?.gitHubCredentialCopy === true;
  const allowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const signIn = useGitHubSignInAvailable(environmentId);
  return (supported && allowed) || signIn;
}

const failureText = (result: { _tag: string }, fallback: string) => {
  const cause = squashAtomCommandFailure(result as never);
  return cause instanceof Error && cause.message ? cause.message : fallback;
};

/**
 * A machine's GitHub access and the ways to give it one, for SpecWithCode's GitHub
 * features there. It shows what the machine already has and never changes it on its
 * own: a working login stays, and copying the sign-in of the machine this app runs on
 * is then only a secondary choice. A copy is stored in that machine's secret store and
 * used by SpecWithCode alone; gh, git config and credential helpers there stay as they
 * are. With no login yet, the copy is the default when the source machine's setting
 * says so, and a one-time code is the other way (or the only one, on older servers).
 */
export function GitHubCredentialCard({
  environmentId,
  environmentLabel,
  onChanged,
  onState,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly onChanged?: () => void;
  /** Reports what the machine uses for GitHub each time it is read. */
  readonly onState?: (state: GitHubCredentialState) => void;
}) {
  const workerSupported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment?.capabilities
      ?.gitHubCredentialCopy === true;
  const workerAllowed = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const deviceCodeSupported = useGitHubSignInAvailable(environmentId);
  const primaryId = usePrimaryEnvironmentId();
  const sourceId = primaryId !== null && primaryId !== environmentId ? primaryId : null;
  const sourceConfig = useAtomValue(serverEnvironment.configValueAtom(sourceId ?? environmentId));
  const sourceAllowed = useEnvironmentScope(sourceId, AuthSettingsWriteScope);
  const sourcePresentation = useEnvironment(sourceId);
  const sourceGitHub = useEnvironmentSettings(sourceId ?? environmentId, (s) => s.github);
  const copySupported =
    sourceId !== null &&
    workerSupported &&
    workerAllowed &&
    sourceAllowed &&
    sourceConfig?.environment?.capabilities?.gitHubCredentialCopy === true;
  const sourceName =
    sourceConfig?.environment?.platform?.os === "darwin"
      ? "this Mac"
      : (sourcePresentation?.label ?? "this machine");
  const sourceLabel = sourcePresentation?.label ?? sourceName;

  const options = { reportFailure: false } as const;
  const readState = useAtomCommand(gitHubCredential.state, options);
  const removeCopied = useAtomCommand(gitHubCredential.removeCopied, options);
  const readPreview = useAtomCommand(gitHubCredential.copyPreview, options);
  const copy = useAtomCommand(gitHubCredential.copy, options);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, options);
  const [state, setState] = useState<GitHubCredentialState | null>(null);
  const [preview, setPreview] = useState<GitHubCredentialCopyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await readState({ environmentId, input: {} });
    if (result._tag === "Success") setState(result.value);
    else setError(failureText(result, `${environmentLabel}'s GitHub access could not be read.`));
  }, [environmentId, environmentLabel, readState]);

  useEffect(() => {
    if (!workerSupported || !workerAllowed) return;
    void refresh();
  }, [refresh, workerAllowed, workerSupported]);

  useEffect(() => {
    if (state !== null) onState?.(state);
  }, [onState, state]);

  useEffect(() => {
    if (!copySupported || sourceId === null) return;
    let live = true;
    void readPreview({
      environmentId: sourceId,
      input: { targetEnvironmentId: environmentId },
    }).then((result) => {
      if (live && result._tag === "Success") setPreview(result.value);
    });
    return () => {
      live = false;
    };
  }, [copySupported, environmentId, readPreview, sourceId]);

  if (!workerSupported || !workerAllowed)
    return (
      <GitHubSignInPanel
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        {...(onChanged ? { onSignedIn: onChanged } : {})}
      />
    );
  if (state === null)
    return (
      <p className="mt-1 text-xs text-muted-foreground" data-slot="github-credential">
        {error ?? `Checking GitHub on ${environmentLabel}…`}
      </p>
    );

  const plan = planGitHubCredential({
    state,
    copySupported,
    preview,
    copyByDefault: sourceGitHub.copyHostSignIn !== false,
    deviceCodeSupported,
  });
  const inUse = state.inUse;
  const sourceLogin = preview?.login ? ` (${preview.login})` : "";
  const copyLabel = plan.replacesSaved
    ? `Replace the saved token with ${sourceName}'s sign-in${sourceLogin}`
    : inUse !== null
      ? `Use ${sourceName}'s sign-in${sourceLogin} instead`
      : `Use ${sourceName}'s GitHub sign-in`;

  const runCopy = async () => {
    if (sourceId === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await copy({
        environmentId: sourceId,
        input: {
          targetEnvironmentId: environmentId,
          ...(plan.replacesSaved ? { replaceSaved: true } : {}),
        },
      });
      if (result._tag === "Failure") {
        setError(failureText(result, "The GitHub sign-in could not be copied."));
        return;
      }
      // Remembered only once a copy went through.
      if (dontAsk)
        await updateSettings({
          environmentId: sourceId,
          input: { patch: { github: { confirmCopySignIn: false } } },
        });
      setConfirming(false);
      setDone(`Signed in as ${result.value.login} (copied from ${sourceLabel}).`);
      await refresh();
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };
  // Replacing a token saved by hand is always confirmed.
  const startCopy = () =>
    sourceGitHub.confirmCopySignIn === false && !plan.replacesSaved
      ? void runCopy()
      : setConfirming(true);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await removeCopied({ environmentId, input: {} });
      if (result._tag === "Failure")
        setError(failureText(result, "The copied sign-in could not be removed."));
      else {
        setState(result.value);
        setDone(null);
        onChanged?.();
      }
    } finally {
      setBusy(false);
    }
  };

  const summary =
    inUse === null
      ? `No GitHub sign-in on ${environmentLabel} yet.`
      : inUse.source === "copied"
        ? `Signed in as ${inUse.login ?? "a GitHub account"} (copied from ${state.saved?.copiedFrom ?? "another machine"}).`
        : inUse.source === "saved"
          ? `Using a GitHub token saved in Settings on ${environmentLabel}${inUse.login ? ` (${inUse.login})` : ""}.`
          : inUse.source === "env"
            ? `Using ${state.environmentVariables.join(", ")} set for the server on ${environmentLabel}${inUse.login ? ` (${inUse.login})` : ""}.`
            : `Already signed in as ${inUse.login} on ${environmentLabel}.`;

  return (
    <div className="mt-1 grid min-w-0 gap-2 text-xs" data-slot="github-credential">
      <p className="wrap-anywhere">
        {summary}
        {plan.sameAccount && inUse?.source !== "copied" && preview?.login
          ? ` Same account as ${sourceLabel}; nothing to copy.`
          : ""}
      </p>
      {state.ghAccounts.length > 0 && inUse?.source !== "gh" ? (
        <p className="text-muted-foreground wrap-anywhere">
          gh on {environmentLabel}:{" "}
          {state.ghAccounts
            .map(
              (account) =>
                `${account.login}${account.active ? " (active)" : ""}${account.authenticated ? "" : " (not working)"}`,
            )
            .join(", ")}
          . SpecWithCode never switches or removes it.
        </p>
      ) : null}
      {inUse?.source === "copied" ? (
        <p className="text-muted-foreground">
          SpecWithCode's pull requests and reviews on {environmentLabel}, and the agents, terminals
          and git it starts there, use the copied sign-in for github.com over HTTPS; it wins over
          GH_TOKEN and gh there. {environmentLabel}'s gh logins, git config and credential helpers
          stay as they were, and SSH remotes keep using SSH keys.
        </p>
      ) : null}
      {state.credentialHelpers.length > 0 ? (
        <p className="text-muted-foreground wrap-anywhere">
          git credential helpers on {environmentLabel}: {state.credentialHelpers.join(", ")}
          {state.gitHubCredentialHelper ? " (one for github.com)" : ""}.
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-success-foreground">
          {done}
        </p>
      ) : null}
      {confirming && preview?.login ? (
        <div
          className="grid gap-2 rounded-md border border-border bg-muted/30 p-2"
          aria-label="Confirm copying the GitHub sign-in"
        >
          <p className="wrap-anywhere">
            Copy {preview.login}'s GitHub sign-in ({describeToken(preview)}) from {sourceLabel}? It
            is stored only in {environmentLabel}'s secret store and can be removed here; revoking it
            on GitHub signs out every machine using it.
            {plan.replacesSaved
              ? ` It replaces the token saved in Settings on ${environmentLabel}${inUse?.login ? ` (${inUse.login})` : ""}, which is kept and comes back when you remove the copy.`
              : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" disabled={busy} onClick={() => void runCopy()}>
              Copy sign-in
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            {plan.replacesSaved ? null : (
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <Checkbox
                  checked={dontAsk}
                  aria-label="Don't ask again"
                  onCheckedChange={(checked) => setDontAsk(checked === true)}
                />
                Don't ask again
              </label>
            )}
          </div>
        </div>
      ) : (
        <>
          {plan.copy === "primary" ? (
            <div>
              <Button size="xs" disabled={busy} onClick={startCopy}>
                {copyLabel}
              </Button>
            </div>
          ) : null}
          {plan.deviceCode !== "none" ? (
            <GitHubSignInPanel
              environmentId={environmentId}
              environmentLabel={environmentLabel}
              onSignedIn={() => {
                void refresh();
                onChanged?.();
              }}
              {...(plan.deviceCode === "secondary"
                ? { startLabel: "Sign in with a code instead", secondary: true }
                : {})}
            />
          ) : null}
          {plan.copy === "secondary" ? (
            <div>
              <Button size="xs" variant="ghost" disabled={busy} onClick={startCopy}>
                {copyLabel}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {inUse?.source === "copied" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void remove()}>
            Remove copied sign-in
          </Button>
          {plan.otherGhLogin ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove()}>
              Use gh's {plan.otherGhLogin} for SpecWithCode instead
            </Button>
          ) : null}
        </div>
      ) : null}
      {inUse === null && copySupported && preview && !preview.available && preview.message ? (
        <p className="text-muted-foreground wrap-anywhere">{preview.message}</p>
      ) : null}
      {error ? (
        <p role="alert" className="wrap-anywhere text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}
