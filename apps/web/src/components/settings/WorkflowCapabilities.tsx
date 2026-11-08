import type { ProjectSkillPresence, WorkflowPreflight } from "@specweave-studio/contracts";

import { useTx } from "../../i18n";

const statusLabel = {
  ready: "Declared dependencies present",
  blocked: "Cannot run here",
  unknown: "Readiness unknown",
};
function Evidence({ workflow }: { workflow: WorkflowPreflight }) {
  const tx = useTx();
  const scope = workflow.scope;
  return (
    <div className="space-y-2 rounded-lg border border-border p-3" data-testid="workflow-evidence">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong>{tx(statusLabel[workflow.status])}</strong>
        <span className="text-xs text-muted-foreground">
          {new Date(workflow.checkedAt).toLocaleString()}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <dt>{tx("Machine")}</dt>
        <dd className="break-all">{scope.environmentId ?? tx("Identity not reported")}</dd>
        <dt>{tx("Provider")}</dt>
        <dd className="break-all">{scope.instanceId}</dd>
        <dt>{tx("Folder")}</dt>
        <dd className="break-all">{scope.workspaceRoot}</dd>
        {scope.nativeThreadId ? (
          <>
            <dt>{tx("Native thread")}</dt>
            <dd className="break-all">{scope.nativeThreadId}</dd>
          </>
        ) : null}
        <dt>{tx("Session")}</dt>
        <dd className="break-all">{scope.sessionId ?? tx("No live session selected")}</dd>
        {scope.threadId ? (
          <>
            <dt>{tx("Thread")}</dt>
            <dd className="break-all">{scope.threadId}</dd>
          </>
        ) : null}
      </dl>
      <div className="space-y-2" aria-label={tx("Capability evidence stages")}>
        {(
          [
            ["Configured", workflow.configured],
            ["Discovered", workflow.discovered],
            ["Registered in session", workflow.registered],
            ["Last safe check", workflow.checked],
          ] as const
        ).map(([label, evidence]) => (
          <div key={label} className="text-xs">
            <span className="font-medium">
              {tx(label)}: {evidence.state}
            </span>
            <p className="text-muted-foreground">{evidence.reason}</p>
            {evidence.observedAt ? (
              <time className="text-muted-foreground" dateTime={evidence.observedAt}>
                {new Date(evidence.observedAt).toLocaleString()}
              </time>
            ) : null}
          </div>
        ))}
      </div>
      {workflow.checks.length ? (
        <ul className="space-y-1 text-xs" aria-label={tx("Workflow dependencies")}>
          {workflow.checks.map((check) => (
            <li key={`${check.kind}:${check.id}`}>
              <span className="font-medium">
                {check.kind} {check.id}: {check.state}
              </span>
              <p className="text-muted-foreground">{check.reason}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function WorkflowCapabilities({ presence }: { presence: ProjectSkillPresence }) {
  const tx = useTx();
  return (
    <section
      className="space-y-2"
      aria-label={tx("{label} workflow capabilities", { label: presence.label })}
    >
      <h3 className="font-medium">{tx("{label} dependency checks", { label: presence.label })}</h3>
      <p className="text-xs text-muted-foreground">
        {tx(
          "Discovery does not prove instructions loaded or service access. Checks apply only to the machine, provider, folder and session shown.",
        )}
      </p>
      {presence.workflow ? (
        <Evidence workflow={presence.workflow} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {tx(
            "Readiness unknown. This machine has not supplied dependency evidence; refresh or update its server.",
          )}
        </p>
      )}
      {presence.workflows?.map((workflow) => (
        <Evidence
          key={`${workflow.scope.sessionId}:${workflow.scope.threadId}`}
          workflow={workflow}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        {tx(
          "Tools from another machine or account do not satisfy these checks. Configure missing dependencies on this machine; sign-in and access remain under your control.",
        )}
      </p>
    </section>
  );
}
