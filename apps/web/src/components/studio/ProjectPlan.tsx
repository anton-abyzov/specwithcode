import { useRef, useState } from "react";
import {
  AuthTerminalOperateScope,
  CommandId,
  type ProjectPlanDefinition,
  type ProjectPlanSnapshot,
  type ProjectPlanTask,
  type ThreadId,
} from "@specweave-studio/contracts";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";
import ChatMarkdown from "../ChatMarkdown";
import { PlanTaskClaim, usePlanClaimMachines } from "./PlanTaskClaim";
import { randomUUID } from "../../lib/utils";

const EMPTY: ProjectPlanDefinition = { spec: "", criteria: [], tasks: [] };
const labels = {
  planned: "Planned",
  in_progress: "In progress",
  blocked: "Blocked",
  reported_done: "Reported done",
  verified: "Verified",
};
const nextId = (prefix: string, rows: ReadonlyArray<{ id: string }>) => {
  let n = 1;
  while (rows.some((row) => row.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
};
const definitionOf = (plan: ProjectPlanSnapshot): ProjectPlanDefinition =>
  plan.native
    ? {
        spec: plan.native.spec,
        criteria: plan.native.criteria,
        tasks: plan.native.tasks.map(({ id, title, criterionIds, verification }) => ({
          id,
          title,
          criterionIds,
          verification,
        })),
      }
    : EMPTY;
const verificationRequests = new Map<string, string>();
const verificationKey = (project: EnvironmentProject, taskId: string) =>
  JSON.stringify([project.environmentId, project.id, taskId]);
function rememberedVerification(key: string): string | undefined {
  const storageKey = `studio:project-verification:${key}`;
  const pending = verificationRequests.get(storageKey);
  if (pending) return pending;
  try {
    const existing = sessionStorage.getItem(storageKey);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
  } catch {
    /* Current-tab memory remains available when browser storage is disabled. */
  }
  return verificationRequests.get(storageKey);
}
/** Persist an uncertain request across definition edits and dialog/browser reloads. */
export function verificationRequestId(key: string, fresh = false, recordedId?: string): string {
  const storageKey = `studio:project-verification:${key}`;
  const id = (!fresh && (rememberedVerification(key) ?? recordedId)) || randomUUID();
  verificationRequests.set(storageKey, id);
  try {
    sessionStorage.setItem(storageKey, id);
  } catch {
    /* Current request remains usable. */
  }
  return id;
}
export function ProjectPlan({
  project,
  canOperate,
  onClose,
  onOpenThread,
  onExecuteTask,
}: {
  project: EnvironmentProject;
  canOperate: boolean;
  onClose: () => void;
  onOpenThread: (id: ThreadId) => void;
  onExecuteTask: (taskId: string) => Promise<void>;
}) {
  const query = useEnvironmentQuery(
    projectWorkspace.plan({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const authorityQuery = useEnvironmentQuery(
    query.error
      ? projectWorkspace.planAuthority({
          environmentId: project.environmentId,
          input: { projectId: project.id },
        })
      : null,
  );
  const canRun = useEnvironmentScope(project.environmentId, AuthTerminalOperateScope);
  const [accepted, setAccepted] = useState<ProjectPlanSnapshot | null>(null);
  const snapshot =
    accepted && (!query.data || accepted.revision >= query.data.revision) ? accepted : query.data;
  const [draft, setDraft] = useState<ProjectPlanDefinition | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [closeWarning, setCloseWarning] = useState(false);
  const [configure, setConfigure] = useState(false);
  const [root, setRoot] = useState(project.workspaceRoot);
  const [increment, setIncrement] = useState("");
  const [discard, setDiscard] = useState(false);
  const replace = useAtomCommand(projectWorkspace.planReplace, { reportFailure: false });
  const bind = useAtomCommand(projectWorkspace.planConfigure, { reportFailure: false });
  const claim = useAtomCommand(projectWorkspace.planClaim, { reportFailure: false });
  const release = useAtomCommand(projectWorkspace.planRelease, { reportFailure: false });
  const report = useAtomCommand(projectWorkspace.planReport, { reportFailure: false });
  const verify = useAtomCommand(projectWorkspace.planVerify, { reportFailure: false });
  const exportPlan = useAtomCommand(projectWorkspace.planExport, { reportFailure: false });
  const claimMachines = usePlanClaimMachines(snapshot);
  const disabled = busy || !canOperate;
  const input = { projectId: project.id, expectedRevision: snapshot?.revision ?? 0 };
  const envelope = { environmentId: project.environmentId };
  async function operation<A, E>(
    run: () => Promise<AtomCommandResult<A, E>>,
    success: (value: A) => void,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await run();
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        throw new Error(
          cause instanceof Error
            ? cause.message
            : "Operation was not confirmed. Your draft is preserved.",
        );
      }
      success(result.value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Operation was not confirmed.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function saved(value: ProjectPlanSnapshot) {
    setAccepted(value);
    query.refresh();
  }
  function startEditing() {
    if (!snapshot) return;
    setDraft(definitionOf(snapshot));
    setDraftRevision(snapshot.revision);
    setError(null);
  }
  function close() {
    if (busy) return;
    if (draft) setCloseWarning(true);
    else onClose();
  }
  function runVerification(task: ProjectPlanTask, fresh = false) {
    if (!snapshot || !canRun || disabled) return;
    const key = verificationKey(project, task.id);
    const existing = rememberedVerification(key) ?? task.evidence.at(-1)?.commandId;
    void operation(
      () =>
        verify({
          ...envelope,
          input: {
            ...input,
            taskId: task.id,
            commandId: CommandId.make(verificationRequestId(key, fresh, existing)),
            recheckOnly: !fresh && Boolean(existing),
          },
        }),
      saved,
    );
  }
  async function askCoordinator(taskId: string) {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onExecuteTask(taskId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Coordinator delivery was not confirmed.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup
        className="h-[min(900px,94dvh)] w-[min(1040px,calc(100vw-32px))] max-w-none overflow-hidden"
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        <div className="project-surface project-plan-dialog">
          <div className="project-plan-heading">
            <div>
              <p className="project-eyebrow">{project.title}</p>
              <DialogTitle>Project plan</DialogTitle>
              <DialogDescription>
                Optional shared spec, assignments, and verification evidence. Chat and delegation
                work without a plan.
              </DialogDescription>
            </div>
            <button
              className="project-control"
              onClick={close}
              disabled={busy}
              aria-label="Close project plan"
            >
              Close
            </button>
          </div>
          <div className="project-plan-body">
            {(error || query.error) && (
              <div className="project-notice" role="alert">
                <p>{error ?? query.error}</p>
                <button
                  className="project-control"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    query.refresh();
                    authorityQuery.refresh();
                  }}
                >
                  Reload saved plan
                </button>
                {draft && (
                  <p>
                    Your edit is preserved. Discard it explicitly before starting from the reloaded
                    plan.
                  </p>
                )}
              </div>
            )}
            {!snapshot && !query.error && <p role="status">Loading plan…</p>}
            {!snapshot && query.error && authorityQuery.data?.authority.kind === "specweave" && (
              <section className="project-plan-source" aria-label="Repair plan source">
                <h3>Repair the configured source</h3>
                <p>
                  The configured source could not be read. Restore its files and reload, or
                  explicitly start an empty SpecWithCode plan. No fallback plan has been created.
                </p>
                <code>
                  {authorityQuery.data.authority.root}/.specweave/increments/
                  {authorityQuery.data.authority.incrementId}
                </code>
                <p className="project-muted">
                  Binding revision {authorityQuery.data.revision}. Source files and external claims
                  stay untouched.
                </p>
                <button
                  className="project-control"
                  disabled={disabled}
                  onClick={() => {
                    const metadata = authorityQuery.data;
                    if (metadata)
                      void operation(
                        () =>
                          bind({
                            ...envelope,
                            input: {
                              projectId: project.id,
                              expectedRevision: metadata.revision,
                              authority: { kind: "native" },
                              discardNative: false,
                            },
                          }),
                        saved,
                      );
                  }}
                >
                  Use an empty SpecWithCode plan
                </button>
              </section>
            )}
            {!snapshot && authorityQuery.error && <p role="alert">{authorityQuery.error}</p>}

            {snapshot && (
              <>
                <div className="project-section-title">
                  <span className="project-muted">
                    {snapshot.authority.kind === "native"
                      ? "SpecWithCode plan"
                      : "SpecWeave source · Read only"}{" "}
                    · Revision {snapshot.revision}
                  </span>
                  <div className="project-actions">
                    {snapshot.native && !draft && (
                      <button
                        className="project-control"
                        disabled={disabled}
                        onClick={startEditing}
                      >
                        {snapshot.native.spec || snapshot.native.tasks.length
                          ? "Edit plan"
                          : "Add a plan"}
                      </button>
                    )}
                    {snapshot.native && (
                      <button
                        className="project-control"
                        disabled={busy}
                        onClick={() =>
                          void operation(
                            () => exportPlan({ ...envelope, input: { projectId: project.id } }),
                            (value) => {
                              const url = URL.createObjectURL(
                                new Blob([value.content], { type: "text/markdown;charset=utf-8" }),
                              );
                              const anchor = document.createElement("a");
                              anchor.href = url;
                              anchor.download = value.filename;
                              anchor.click();
                              setTimeout(() => URL.revokeObjectURL(url), 0);
                            },
                          )
                        }
                      >
                        Export Markdown
                      </button>
                    )}
                    <button
                      className="project-control"
                      disabled={disabled || Boolean(draft)}
                      onClick={() => setConfigure(!configure)}
                    >
                      Plan source
                    </button>
                  </div>
                </div>
                {configure && (
                  <section className="project-plan-source" aria-label="Plan source">
                    <h3>One authoritative plan</h3>
                    <p className="project-muted">
                      Use SpecWithCode without any CLI, or explicitly connect an existing SpecWeave
                      increment. Connected files are read only; SpecWithCode never takes existing
                      claims or creates a second ledger.
                    </p>
                    {snapshot.authority.kind === "specweave" ? (
                      <>
                        <code>
                          {snapshot.authority.root}/.specweave/increments/
                          {snapshot.authority.incrementId}
                        </code>
                        <p>
                          Switching to SpecWithCode starts an empty plan. Source files remain
                          untouched.
                        </p>
                        <button
                          className="project-control"
                          disabled={disabled}
                          onClick={() =>
                            void operation(
                              () =>
                                bind({
                                  ...envelope,
                                  input: {
                                    ...input,
                                    authority: { kind: "native" },
                                    discardNative: false,
                                  },
                                }),
                              (value) => {
                                saved(value);
                                setConfigure(false);
                              },
                            )
                          }
                        >
                          Use an empty SpecWithCode plan
                        </button>
                      </>
                    ) : (
                      <>
                        <label>
                          SpecWeave root
                          <input
                            aria-label="SpecWeave root"
                            value={root}
                            onChange={(event) => setRoot(event.target.value)}
                          />
                        </label>
                        <p className="project-muted">
                          Use this project's folder or a folder already approved in Environment.
                          Removing that approval stops access to the connected plan.
                        </p>
                        <label>
                          Increment ID
                          <input
                            aria-label="Increment ID"
                            placeholder="0888-example"
                            value={increment}
                            onChange={(event) => setIncrement(event.target.value)}
                          />
                        </label>
                        <label className="project-checkbox">
                          <input
                            type="checkbox"
                            checked={discard}
                            onChange={(event) => setDiscard(event.target.checked)}
                          />
                          Replace the saved SpecWithCode plan with this read-only source. Release
                          all assignments first.
                        </label>
                        <button
                          className="project-control"
                          disabled={
                            disabled ||
                            !root.trim() ||
                            !/^\d{4,}-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(increment)
                          }
                          onClick={() =>
                            void operation(
                              () =>
                                bind({
                                  ...envelope,
                                  input: {
                                    ...input,
                                    authority: { kind: "specweave", root, incrementId: increment },
                                    discardNative: discard,
                                  },
                                }),
                              (value) => {
                                saved(value);
                                setConfigure(false);
                              },
                            )
                          }
                        >
                          Connect SpecWeave source
                        </button>
                      </>
                    )}
                  </section>
                )}
                {draft ? (
                  <PlanEditor draft={draft} disabled={disabled} onChange={setDraft} />
                ) : snapshot.native ? (
                  <>
                    {snapshot.native.spec ? (
                      <section className="project-plan-spec">
                        <ChatMarkdown text={snapshot.native.spec} cwd={project.workspaceRoot} />
                      </section>
                    ) : (
                      <div className="project-plan-empty">
                        <h3>Start with the outcome.</h3>
                        <p>
                          A short spec is enough. Add criteria and tasks only when the work needs
                          them.
                        </p>
                      </div>
                    )}
                    {snapshot.native.criteria.length > 0 && (
                      <section>
                        <h3>Acceptance criteria</h3>
                        <ul className="project-plan-criteria">
                          {snapshot.native.criteria.map((criterion) => (
                            <li key={criterion.id}>
                              <code>{criterion.id}</code>
                              <span>{criterion.text}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    )}
                    <section aria-label="Plan tasks">
                      <div className="project-section-title">
                        <h3>Tasks</h3>
                        <span className="project-muted">
                          {
                            snapshot.native.tasks.filter((task) => task.status === "verified")
                              .length
                          }{" "}
                          verified / {snapshot.native.tasks.length}
                        </span>
                      </div>
                      {snapshot.native.tasks.map((task) => (
                        <article className="project-plan-task" key={task.id}>
                          <div className="project-section-title">
                            <h4>
                              <code>{task.id}</code> {task.title}
                            </h4>
                            <span
                              className={`project-plan-status project-plan-status-${task.status}`}
                            >
                              {labels[task.status]}
                            </span>
                          </div>
                          <p className="project-muted">
                            {task.criterionIds.join(" · ") || "No criteria linked"} ·{" "}
                            <PlanTaskClaim
                              task={task}
                              here={snapshot.environmentId ?? project.environmentId}
                              machines={claimMachines}
                              onOpenThread={(threadId) => {
                                onOpenThread(threadId);
                                onClose();
                              }}
                            />
                          </p>
                          {task.note && <p className="project-plan-note">{task.note}</p>}
                          <div className="project-actions">
                            <button
                              className="project-control"
                              disabled={disabled}
                              onClick={() => void askCoordinator(task.id)}
                            >
                              Ask coordinator
                            </button>
                            {!task.owner ? (
                              <button
                                className="project-control"
                                disabled={disabled}
                                onClick={() =>
                                  void operation(
                                    () =>
                                      claim({ ...envelope, input: { ...input, taskId: task.id } }),
                                    saved,
                                  )
                                }
                              >
                                Claim for me
                              </button>
                            ) : (
                              <button
                                className="project-control"
                                disabled={disabled}
                                onClick={() =>
                                  void operation(
                                    () =>
                                      release({
                                        ...envelope,
                                        input: {
                                          ...input,
                                          taskId: task.id,
                                          expectedOwner: task.owner,
                                        },
                                      }),
                                    saved,
                                  )
                                }
                              >
                                Release assignment
                              </button>
                            )}
                            {task.owner?.kind === "user" && (
                              <button
                                className="project-control"
                                disabled={disabled}
                                onClick={() =>
                                  void operation(
                                    () =>
                                      report({
                                        ...envelope,
                                        input: {
                                          ...input,
                                          taskId: task.id,
                                          status: "reported_done",
                                          note: task.note,
                                        },
                                      }),
                                    saved,
                                  )
                                }
                              >
                                Mark reported done
                              </button>
                            )}
                          </div>
                          {(task.verification ||
                            task.evidence.length > 0 ||
                            rememberedVerification(verificationKey(project, task.id))) && (
                            <details className="project-plan-evidence">
                              <summary>Verification command and evidence</summary>
                              {task.verification && (
                                <>
                                  <p>
                                    Runs on this host in <code>{project.workspaceRoot}</code> only
                                    when you request it.
                                  </p>
                                  <pre>
                                    {[task.verification.executable, ...task.verification.args]
                                      .map((arg) => JSON.stringify(arg))
                                      .join(" ")}
                                  </pre>
                                  <p className="project-muted">
                                    Timeout {task.verification.timeoutMs / 1000}s · Output is
                                    bounded. Arguments are passed literally.
                                  </p>
                                </>
                              )}
                              <div className="project-actions">
                                <button
                                  className="project-control"
                                  disabled={disabled || !canRun}
                                  onClick={() => runVerification(task)}
                                >
                                  {task.evidence.length > 0 ||
                                  rememberedVerification(verificationKey(project, task.id))
                                    ? "Recheck last request"
                                    : "Run verification"}
                                </button>
                                {task.verification &&
                                  (task.evidence.length > 0 ||
                                    rememberedVerification(verificationKey(project, task.id))) && (
                                    <button
                                      className="project-control"
                                      disabled={disabled || !canRun}
                                      onClick={() => runVerification(task, true)}
                                    >
                                      New verification attempt
                                    </button>
                                  )}
                              </div>
                              {!canRun && (
                                <p className="project-muted">
                                  Terminal operation permission is required to run verification.
                                </p>
                              )}
                              {task.evidence.map((evidence) => (
                                <div className="project-plan-receipt" key={evidence.commandId}>
                                  <strong>{evidence.outcome}</strong> · Exit{" "}
                                  {evidence.exitCode ?? "unknown"} ·{" "}
                                  {evidence.finishedAt ?? "Completion not confirmed"}
                                  <p className="project-muted">
                                    Definition revision {evidence.contentRevision} ·{" "}
                                    {evidence.truncated ? "Output truncated" : "Captured output"}
                                  </p>
                                  <pre>
                                    {[evidence.command.executable, ...evidence.command.args]
                                      .map((arg) => JSON.stringify(arg))
                                      .join(" ")}
                                  </pre>
                                  <p className="project-muted">
                                    Executed in {evidence.workspaceRoot}
                                  </p>
                                  <pre>
                                    {evidence.stdout || evidence.stderr
                                      ? `${evidence.stdout}${evidence.stderr ? `\n${evidence.stderr}` : ""}`
                                      : "No output recorded."}
                                  </pre>
                                  <code>SHA-256 {evidence.outputSha256}</code>
                                  {evidence.outcome === "unknown" && (
                                    <p>
                                      This request may have run. Rechecking cannot run it twice. Use
                                      a new attempt only when you intend another execution.
                                    </p>
                                  )}
                                </div>
                              ))}
                            </details>
                          )}
                        </article>
                      ))}
                      {!snapshot.native.tasks.length && (
                        <p className="project-muted">
                          No tasks yet. Ordinary project work can continue.
                        </p>
                      )}
                    </section>
                  </>
                ) : (
                  snapshot.external && (
                    <>
                      <p className="project-muted">
                        Source revision {snapshot.external.sourceRevision.slice(0, 12)} ·{" "}
                        {snapshot.external.specPath}
                      </p>
                      <section className="project-plan-spec">
                        <ChatMarkdown text={snapshot.external.spec} cwd={project.workspaceRoot} />
                      </section>
                      <p className="project-notice">
                        External ledger statuses are reported by their owners. SpecWithCode has not
                        independently verified their tests.
                      </p>
                      {snapshot.external.tasks.map((task) => (
                        <article className="project-plan-task" key={task.id}>
                          <h4>
                            {task.id} · {task.title}
                          </h4>
                          <p>
                            {task.status} · {task.owner ?? "Unassigned"} · External, unverified
                          </p>
                          {task.evidence && <pre>{task.evidence}</pre>}
                        </article>
                      ))}
                    </>
                  )
                )}
                {draft && (
                  <div className="project-plan-save">
                    <button
                      className="project-control project-primary"
                      disabled={disabled}
                      onClick={() =>
                        void operation(
                          () =>
                            replace({
                              ...envelope,
                              input: {
                                projectId: project.id,
                                expectedRevision: draftRevision,
                                definition: draft,
                              },
                            }),
                          (value) => {
                            saved(value);
                            setDraft(null);
                          },
                        )
                      }
                    >
                      Save plan
                    </button>
                    <button
                      className="project-control"
                      disabled={busy}
                      onClick={() => {
                        setDraft(null);
                        setError(null);
                      }}
                    >
                      Discard edit
                    </button>
                    <p className="project-muted">
                      Saving a changed definition invalidates prior verification. Existing evidence
                      stays in history.
                    </p>
                  </div>
                )}
              </>
            )}
            {closeWarning && (
              <div className="project-notice" role="alert">
                <p>Discard this unsaved plan edit?</p>
                <button className="project-control" onClick={onClose}>
                  Discard and close
                </button>
                <button className="project-control" onClick={() => setCloseWarning(false)}>
                  Keep editing
                </button>
              </div>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
function PlanEditor({
  draft,
  disabled,
  onChange,
}: {
  draft: ProjectPlanDefinition;
  disabled: boolean;
  onChange: (value: ProjectPlanDefinition) => void;
}) {
  return (
    <div className="project-plan-editor">
      <label>
        Spec
        <textarea
          aria-label="Plan spec"
          rows={8}
          value={draft.spec}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, spec: event.target.value })}
          placeholder="What should change, and what does success look like?"
        />
      </label>
      <div className="project-section-title">
        <h3>Acceptance criteria</h3>
        <button
          className="project-control"
          disabled={disabled || draft.criteria.length >= 128}
          onClick={() =>
            onChange({
              ...draft,
              criteria: [...draft.criteria, { id: nextId("AC", draft.criteria), text: "" }],
            })
          }
        >
          Add criterion
        </button>
      </div>
      {draft.criteria.map((criterion) => (
        <div className="project-plan-edit-row" key={criterion.id}>
          <code>{criterion.id}</code>
          <input
            aria-label={`${criterion.id} criterion`}
            value={criterion.text}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...draft,
                criteria: draft.criteria.map((row) =>
                  row.id === criterion.id ? { ...row, text: event.target.value } : row,
                ),
              })
            }
          />
          <button
            className="project-control"
            aria-label={`Remove ${criterion.id}`}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...draft,
                criteria: draft.criteria.filter((row) => row.id !== criterion.id),
                tasks: draft.tasks.map((task) => ({
                  ...task,
                  criterionIds: task.criterionIds.filter((id) => id !== criterion.id),
                })),
              })
            }
          >
            Remove
          </button>
        </div>
      ))}
      <div className="project-section-title">
        <h3>Tasks</h3>
        <button
          className="project-control"
          disabled={disabled || draft.tasks.length >= 200}
          onClick={() =>
            onChange({
              ...draft,
              tasks: [
                ...draft.tasks,
                { id: nextId("T", draft.tasks), title: "", criterionIds: [], verification: null },
              ],
            })
          }
        >
          Add task
        </button>
      </div>
      {draft.tasks.map((task) => {
        const edit = (patch: Partial<typeof task>) =>
          onChange({
            ...draft,
            tasks: draft.tasks.map((row) => (row.id === task.id ? { ...row, ...patch } : row)),
          });
        return (
          <article className="project-plan-task" key={task.id}>
            <div className="project-plan-edit-row">
              <code>{task.id}</code>
              <input
                aria-label={`${task.id} title`}
                value={task.title}
                disabled={disabled}
                onChange={(event) => edit({ title: event.target.value })}
              />
              <button
                className="project-control"
                aria-label={`Remove ${task.id}`}
                disabled={disabled}
                onClick={() =>
                  onChange({ ...draft, tasks: draft.tasks.filter((row) => row.id !== task.id) })
                }
              >
                Remove
              </button>
            </div>
            <div className="project-plan-links">
              {draft.criteria.map((criterion) => (
                <label className="project-checkbox" key={criterion.id}>
                  <input
                    type="checkbox"
                    checked={task.criterionIds.includes(criterion.id)}
                    disabled={disabled}
                    onChange={(event) =>
                      edit({
                        criterionIds: event.target.checked
                          ? [...task.criterionIds, criterion.id]
                          : task.criterionIds.filter((id) => id !== criterion.id),
                      })
                    }
                  />
                  {criterion.id}
                </label>
              ))}
            </div>
            <label className="project-checkbox">
              <input
                type="checkbox"
                checked={task.verification !== null}
                disabled={disabled}
                onChange={(event) =>
                  edit({
                    verification: event.target.checked
                      ? { executable: "", args: [], timeoutMs: 30_000 }
                      : null,
                  })
                }
              />
              Save a verification command
            </label>
            {task.verification && (
              <div className="project-plan-command">
                <label>
                  Executable
                  <input
                    aria-label={`${task.id} executable`}
                    disabled={disabled}
                    value={task.verification.executable}
                    onChange={(event) =>
                      edit({
                        verification: { ...task.verification!, executable: event.target.value },
                      })
                    }
                    placeholder="npm"
                  />
                </label>
                <label>
                  Arguments, one per line
                  <textarea
                    aria-label={`${task.id} arguments`}
                    rows={3}
                    disabled={disabled}
                    value={task.verification.args.join("\n")}
                    onChange={(event) =>
                      edit({
                        verification: {
                          ...task.verification!,
                          args: event.target.value === "" ? [] : event.target.value.split("\n"),
                        },
                      })
                    }
                    placeholder={"test\n--\nproject.test.ts"}
                  />
                </label>
                <label>
                  Timeout in seconds
                  <input
                    aria-label={`${task.id} timeout`}
                    type="number"
                    min={0.1}
                    max={120}
                    step={0.1}
                    value={task.verification.timeoutMs / 1000}
                    disabled={disabled}
                    onChange={(event) =>
                      edit({
                        verification: {
                          ...task.verification!,
                          timeoutMs: Math.round(Number(event.target.value) * 1000),
                        },
                      })
                    }
                  />
                </label>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
