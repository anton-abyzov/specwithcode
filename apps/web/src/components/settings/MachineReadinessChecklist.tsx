import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type MachineReadiness,
  type ProjectId,
  type ServerProvider,
} from "@specweave-studio/contracts";

import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineHandoff } from "../../studio/machineHandoff";
import { cliOfDriver, providerLabel } from "../../studio/projectUsageModel";
import { Button } from "../ui/button";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

const providerName = (provider: ServerProvider) =>
  provider.displayName ?? providerLabel(cliOfDriver(provider.driver, provider.instanceId));

const REPOSITORY_PROBLEM: Record<MachineReadiness["repositories"][number]["status"], string> = {
  ok: "Reachable",
  "no-origin": "No origin; it stays local",
  "no-access": "No read access from this machine",
  timeout: "The origin did not answer",
  error: "git could not check it",
};

function Row({
  ok,
  title,
  detail,
  children,
}: {
  readonly ok: boolean | null;
  readonly title: string;
  readonly detail?: string | null;
  readonly children?: React.ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-start gap-2" data-slot="readiness-row" data-ok={ok ?? "info"}>
      {ok === false ? (
        <CircleAlertIcon
          aria-label="Needs attention"
          className="mt-0.5 size-3.5 shrink-0 text-warning-foreground"
        />
      ) : (
        <CheckIcon
          aria-label="Ready"
          className="mt-0.5 size-3.5 shrink-0 text-success-foreground"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="wrap-anywhere">{title}</p>
        {detail ? <p className="wrap-anywhere text-xs text-muted-foreground">{detail}</p> : null}
        {children}
      </div>
    </li>
  );
}

/**
 * What a machine still needs before a project runs there: provider and GitHub
 * sign-ins, read access to each repository origin and the tools the project's
 * actions call. Every check runs on that machine with its own credentials, and
 * signing in happens there too; no credential passes through this browser.
 */
export function MachineReadinessChecklist({
  environmentId,
  environmentLabel,
  projectId,
  autoCheck = true,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly projectId?: ProjectId | null;
  readonly autoCheck?: boolean;
}) {
  const check = useAtomCommand(machineHandoff.readiness, { reportFailure: false });
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [report, setReport] = useState<MachineReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const started = useRef(false);

  const run = useCallback(async () => {
    setChecking(true);
    setError(null);
    const result = await check({
      environmentId,
      input: projectId ? { projectId } : {},
    });
    setChecking(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : `${environmentLabel} could not be checked. It may run an older SpecWithCode.`,
      );
      return;
    }
    setReport(result.value);
  }, [check, environmentId, environmentLabel, projectId]);

  useEffect(() => {
    if (!autoCheck || started.current) return;
    started.current = true;
    void run();
  }, [autoCheck, run]);

  const enabled = providers.filter((provider) => provider.enabled && provider.installed);
  const blocked =
    report?.repositories.filter((repo) => repo.status !== "ok" && repo.status !== "no-origin") ??
    [];
  const missingTools = report?.tools.filter((tool) => !tool.found) ?? [];

  return (
    <section
      className="space-y-2 text-sm"
      data-slot="machine-readiness"
      aria-label={`Ready to work on ${environmentLabel}`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">Ready to work on {environmentLabel}?</h3>
        <Button size="xs" variant="outline" disabled={checking} onClick={() => void run()}>
          {checking ? "Checking…" : report ? "Check again" : "Check readiness"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Sign-ins are never copied between machines. Each one happens on {environmentLabel} itself.
      </p>
      <ul className="space-y-2">
        {enabled.length === 0 ? (
          <Row ok={false} title="No coding agent is installed and enabled there." />
        ) : (
          enabled.map((provider) => {
            const signedIn = provider.auth.status === "authenticated";
            const account = provider.auth.email ?? provider.auth.label ?? null;
            return (
              <Row
                key={provider.instanceId}
                ok={provider.auth.status === "unknown" ? null : signedIn}
                title={`${providerName(provider)}: ${signedIn ? "signed in" : provider.auth.status === "unknown" ? "sign-in not reported" : "not signed in"}`}
                detail={signedIn ? account : null}
              >
                {!signedIn && canManageProviders ? (
                  signingIn === provider.instanceId ? (
                    <div className="mt-2 rounded-lg border p-2">
                      <ProviderAuthenticationSection
                        environmentId={environmentId}
                        environmentLabel={environmentLabel}
                        instanceId={provider.instanceId}
                        provider={provider}
                        readOnly={false}
                      />
                    </div>
                  ) : (
                    <Button
                      className="mt-1"
                      size="xs"
                      variant="outline"
                      onClick={() => setSigningIn(provider.instanceId)}
                    >
                      Sign in on {environmentLabel}
                    </Button>
                  )
                ) : null}
              </Row>
            );
          })
        )}
        {report && (
          <Row
            ok={
              report.github.status === "signed-in"
                ? true
                : report.github.status === "unknown"
                  ? null
                  : false
            }
            title={
              report.github.status === "signed-in"
                ? `GitHub CLI: signed in as ${report.github.accounts.map((account) => `${account.login} (${account.host})`).join(", ")}`
                : report.github.status === "not-installed"
                  ? "GitHub CLI: not installed"
                  : report.github.status === "signed-out"
                    ? "GitHub CLI: not signed in"
                    : "GitHub CLI: sign-in unknown"
            }
            detail={
              report.github.status === "signed-out" || report.github.status === "not-installed"
                ? `Pull requests need it. In a terminal on ${environmentLabel}, run gh auth login.`
                : report.github.detail
            }
          />
        )}
        {report && report.folder && (
          <Row
            ok={blocked.length === 0}
            title={
              blocked.length === 0
                ? `${report.repositories.length} ${report.repositories.length === 1 ? "repository" : "repositories"} checked; every origin is readable`
                : `${blocked.length} of ${report.repositories.length} repositories cannot reach their origin`
            }
            detail={
              report.repositoriesTruncated ? "Only the first 64 repositories were checked." : null
            }
          >
            {blocked.length > 0 && (
              <ul className="mt-1 space-y-1 text-xs">
                {blocked.map((repo) => (
                  <li key={repo.path} className="wrap-anywhere">
                    <span className="font-mono">{repo.path}</span> ({repo.origin ?? "no origin"}):{" "}
                    {REPOSITORY_PROBLEM[repo.status]}
                    {repo.detail ? `. ${repo.detail}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        )}
        {report && report.tools.length > 0 && (
          <Row
            ok={missingTools.length === 0}
            title={
              missingTools.length === 0
                ? "Every tool the project's actions call is installed"
                : `Missing tools: ${missingTools.map((tool) => tool.name).join(", ")}`
            }
            detail={
              missingTools.length > 0
                ? `Used by ${[...new Set(missingTools.map((tool) => tool.action))].join(", ")}. Install them on ${environmentLabel}.`
                : null
            }
          />
        )}
      </ul>
      {error && (
        <p role="alert" className="wrap-anywhere text-xs text-destructive-foreground">
          {error}
        </p>
      )}
    </section>
  );
}
