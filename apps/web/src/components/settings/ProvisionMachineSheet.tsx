import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useState } from "react";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthEnvironmentMaintainScope,
  type EnvironmentId,
  type ProvisionItem,
  type ProvisionReadback,
} from "@specweave-studio/contracts";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineProvision, provisionRunAtom } from "../../studio/machineProvision";
import { canResumeProvision } from "../../studio/provisionRunState";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";

const STATUS_TEXT: Record<ProvisionItem["status"], string> = {
  pending: "Waiting",
  running: "Working…",
  ok: "Up to date",
  "kept-newer": "Newer, kept",
  changed: "Installed",
  planned: "Will install",
  "needs-root": "Needs root",
  "user-action": "Your step",
  failed: "Failed",
  skipped: "Skipped",
};

function statusText(item: ProvisionItem): string {
  if (item.status === "planned" && item.found) return "Will update";
  return STATUS_TEXT[item.status];
}

function StatusIcon({ status }: { readonly status: ProvisionItem["status"] }) {
  if (status === "running")
    return <LoaderCircleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 animate-spin" />;
  if (status === "failed" || status === "needs-root" || status === "user-action")
    return (
      <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
    );
  if (status === "ok" || status === "kept-newer" || status === "changed")
    return <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />;
  return <span aria-hidden className="mt-0.5 size-3.5 shrink-0" />;
}

function Command({ children }: { readonly children: string }) {
  return (
    <code className="mt-1 block select-all rounded bg-muted px-2 py-1 font-mono text-xs wrap-anywhere">
      {children}
    </code>
  );
}

function ItemRow({
  item,
  log,
}: {
  readonly item: ProvisionItem;
  readonly log: ReadonlyArray<string> | undefined;
}) {
  const version =
    item.found && item.found !== item.wanted && item.status !== "ok"
      ? `${item.found} → ${item.wanted}`
      : (item.found ?? item.wanted);
  return (
    <li
      className="flex min-w-0 items-start gap-2"
      data-slot="provision-item"
      data-status={item.status}
    >
      <StatusIcon status={item.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="wrap-anywhere">{item.label}</p>
          <span className="shrink-0 text-xs text-muted-foreground">{statusText(item)}</span>
        </div>
        <p className="wrap-anywhere text-xs text-muted-foreground">
          {version}
          {item.detail ? ` · ${item.detail}` : ""}
        </p>
        {item.command && (item.status === "failed" || item.status === "user-action") ? (
          <Command>{item.command}</Command>
        ) : null}
        {log && log.length > 0 && (item.status === "running" || item.status === "failed") ? (
          <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted px-2 py-1 font-mono text-2xs whitespace-pre-wrap">
            {log.slice(-6).join("\n")}
          </pre>
        ) : null}
      </div>
    </li>
  );
}

function Readback({
  readback,
  environmentLabel,
}: {
  readonly readback: ProvisionReadback;
  readonly environmentLabel: string;
}) {
  return (
    <div className="space-y-3" data-slot="provision-readback">
      <p role="status">{readback.summary}</p>
      {readback.rootStep && !readback.rootStep.ran ? (
        <div className="rounded-lg border border-warning/40 p-2.5">
          <p className="font-medium">One step needs the administrator password</p>
          <p className="text-xs text-muted-foreground">
            SpecWithCode never asks for it. In a terminal on {environmentLabel}, read the script,
            run this line, then press Retry.
          </p>
          <Command>{readback.rootStep.command}</Command>
        </div>
      ) : null}
      {readback.userSteps.length > 0 ? (
        <div>
          <p className="font-medium">Your steps</p>
          <p className="text-xs text-muted-foreground">
            Provisioning never signs in, copies sign-ins, allows workers or turns on billing.
          </p>
          <ul className="mt-1 space-y-2">
            {readback.userSteps.map((step) => (
              <li key={step.id} data-slot="provision-user-step">
                <p className="wrap-anywhere">
                  {step.title}
                  {step.optional ? (
                    <span className="text-xs text-muted-foreground"> (optional)</span>
                  ) : null}
                </p>
                {step.command ? <Command>{step.command}</Command> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {readback.logPath ? (
        <p className="text-xs text-muted-foreground wrap-anywhere">Log: {readback.logPath}</p>
      ) : null}
    </div>
  );
}

/**
 * Installs the default worker set on a connected machine through its own
 * server: the same pinned runner as `specwithcode provision`. It previews
 * first, streams each step, never restarts the server it runs in and leaves
 * sign-ins, Allow workers and root passwords to the user.
 */
export function ProvisionMachineSheet({
  environmentId,
  environmentLabel,
  open,
  onOpenChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const preview = useAtomCommand(machineProvision.preview, { reportFailure: false });
  const run = useAtomCommand(machineProvision.run, { reportFailure: false });
  const state = useAtomValue(provisionRunAtom(environmentId));
  const [plan, setPlan] = useState<ProvisionReadback | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    setPreviewError(null);
    const result = await preview({ environmentId, input: {} });
    setChecking(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setPreviewError(
        cause instanceof Error && cause.message
          ? cause.message
          : `${environmentLabel} could not be checked. It may run an older SpecWithCode.`,
      );
      return;
    }
    setPlan(result.value);
  }, [preview, environmentId, environmentLabel]);

  useEffect(() => {
    if (open && state.status === "idle" && plan === null && !checking && previewError === null)
      void check();
  }, [open, state.status, plan, checking, previewError, check]);

  const start = (resume: boolean) => void run({ environmentId, input: { resume } });

  const running = state.status === "running";
  const ran = state.status !== "idle";
  const items = ran && state.items.length > 0 ? state.items : (plan?.items ?? []);
  const target = (ran ? state.readback?.target : null) ?? plan?.target ?? null;
  const toChange =
    plan?.items.filter((item) => item.status === "planned" || item.status === "needs-root")
      .length ?? 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup className="max-w-lg" layer="dialog" data-testid="provision-machine">
        <SheetHeader>
          <SheetTitle className="me-8">Provision {environmentLabel}</SheetTitle>
          <SheetDescription>
            Installs the tools workers need, at the versions this release pins, on{" "}
            {environmentLabel} itself. It never restarts the SpecWithCode server there, signs in,
            allows workers or turns on billing.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 overflow-y-auto px-6 pb-6 text-sm">
          {target ? (
            <p className="text-xs text-muted-foreground" data-slot="provision-target">
              {target.prettyName} · {target.arch}
              {target.supported ? "" : ` · ${target.reason ?? "Not supported"}`}
            </p>
          ) : null}
          {previewError ? (
            <p role="alert" className="text-warning-foreground">
              {previewError}
            </p>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-warning-foreground">
              {state.error}
            </p>
          ) : null}
          {checking && items.length === 0 ? (
            <p className="text-muted-foreground">Checking {environmentLabel}…</p>
          ) : null}
          {items.length > 0 ? (
            <ul className="space-y-2.5">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} log={state.logs[item.id]} />
              ))}
            </ul>
          ) : null}
          {!running && state.readback && (state.status === "done" || state.status === "failed") ? (
            <Readback readback={state.readback} environmentLabel={environmentLabel} />
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!ran ? (
              <Button
                size="sm"
                disabled={checking || !plan || !plan.target.supported}
                onClick={() => start(false)}
              >
                {plan?.target.supported && toChange === 0
                  ? "Check and finish"
                  : `Provision ${environmentLabel}`}
              </Button>
            ) : null}
            {running ? (
              <Button size="sm" disabled>
                Provisioning…
              </Button>
            ) : null}
            {canResumeProvision(state) ? (
              <Button size="sm" onClick={() => start(true)}>
                Retry
              </Button>
            ) : null}
            {ran && !running ? (
              <Button size="sm" variant="outline" onClick={() => start(false)}>
                Run again
              </Button>
            ) : null}
            {!ran ? (
              <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
                {checking ? "Checking…" : "Check again"}
              </Button>
            ) : null}
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/** The row button; absent when that machine's server predates provisioning. */
export function ProvisionMachineButton({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const supported =
    useAtomValue(serverEnvironment.configValueAtom(environmentId))?.environment.capabilities
      .machineProvision === true;
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  return (
    <>
      <Button
        className="self-start"
        size="xs"
        variant="ghost-muted"
        disabled={!canMaintain}
        title={canMaintain ? undefined : "Needs permission to maintain that machine"}
        onClick={() => setOpen(true)}
      >
        Provision
      </Button>
      {open ? (
        <ProvisionMachineSheet
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
