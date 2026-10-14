import { MspError } from "@muse-code/sdk";
import type { Session } from "@muse-code/sdk";
import * as Effect from "effect/Effect";
import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
type Permission = Parameters<AcpSessionRuntime["Service"]["handleRequestPermission"]>[0];
type Approval = ReturnType<Session["fold"]["pendingApprovals"]>[number]["requested"];
type Question = ReturnType<Session["fold"]["pendingUserInputs"]>[number];
/** The SDK folds questions but does not route them, and does not replay approvals
 * when a callback is installed after resume. One stage-keyed dispatcher owns both
 * the initial pull and live folded requests; SDK onApproval is intentionally unused. */
export async function watchMuseRequests(input: {
  session: Session;
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  command: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  permission: () => Permission | undefined;
  failed: (error: unknown) => void;
}) {
  const abort = new AbortController();
  const handled = new Set<string>();
  const inFlight = new Set<string>();
  const terminalApprovals = new Set<string>();
  const pending = await input.request("approval/listPending", {
    sessionId: input.session.sessionId,
  });
  const restoredApprovals = Array.isArray(pending.approvals)
    ? (pending.approvals as Approval[])
    : [];
  const restoredQuestions = Array.isArray(pending.userInputs)
    ? (pending.userInputs as Question[])
    : [];
  const dispatch = (key: string, run: () => Promise<void>, group?: string) => {
    if (handled.has(key) || abort.signal.aborted || (group && inFlight.has(group))) return;
    handled.add(key);
    if (group) inFlight.add(group);
    void run()
      .catch((error) => {
        if (
          error instanceof MspError &&
          [
            "approvalAlreadyResolved",
            "approvalRequirementStale",
            "userInputAlreadySettled",
          ].includes(String(error.kind))
        ) {
          if (group && error.kind === "approvalAlreadyResolved") terminalApprovals.add(group);
          return;
        }
        if (!abort.signal.aborted) input.failed(error);
      })
      .finally(() => {
        if (group) inFlight.delete(group);
      });
  };
  const tick = () => {
    const handler = input.permission();
    if (abort.signal.aborted) return;
    for (const resolved of input.session.fold.resolvedApprovals())
      terminalApprovals.add(resolved.approvalId);
    const approvals = new Map(restoredApprovals.map((request) => [request.approvalId, request]));
    for (const pending of input.session.fold.pendingApprovals()) {
      if (pending.latestUpdate?.change.kind === "alreadyTerminal") {
        terminalApprovals.add(pending.approvalId);
        continue;
      }
      approvals.set(pending.approvalId, { ...pending.requested, ...pending.latestUpdate });
    }
    for (const request of approvals.values()) {
      if (!handler || terminalApprovals.has(request.approvalId)) continue;
      const key = `${request.approvalId}:${request.currentRequirementId.sourceIndex}`;
      dispatch(
        key,
        async () => {
          const choices = request.availableChoices.filter(
            (c) =>
              c.scope === "once" && ["approved", "denied", "abort"].includes(String(c.decision)),
          );
          const response = await Effect.runPromise(
            handler(
              {
                sessionId: request.sessionId,
                toolCall: {
                  toolCallId: request.toolCallId,
                  title: request.toolName,
                  rawInput: request.rawArgs,
                  status: "pending",
                },
                options: choices.map((c) => ({
                  optionId: c.choiceId,
                  name: c.label,
                  kind:
                    c.decision === "approved" ? ("allow_once" as const) : ("reject_once" as const),
                })),
              },
              { requestId: key, method: "session/request_permission" },
            ),
            { signal: abort.signal },
          );
          const outcome = response.outcome;
          const choice =
            outcome.outcome === "selected"
              ? choices.find((c) => c.choiceId === outcome.optionId)
              : choices.find((c) => c.decision === "abort" || c.decision === "denied");
          if (!choice) throw new Error("Muse Code did not offer the selected approval decision");
          const ack = await input.command("approval/decide", {
            sessionId: request.sessionId,
            approvalId: request.approvalId,
            requirementId: request.currentRequirementId,
            choiceId: choice.choiceId,
          });
          if (ack.terminal === true) terminalApprovals.add(request.approvalId);
        },
        request.approvalId,
      );
    }
    const settledQuestions = new Set(
      input.session.fold.settledUserInputs().map((question) => question.userInputId),
    );
    for (const question of [...restoredQuestions, ...input.session.fold.pendingUserInputs()]) {
      if (settledQuestions.has(question.userInputId)) continue;
      dispatch(`question:${question.userInputId}`, async () => {
        await input.command("userInput/cancel", {
          sessionId: question.sessionId,
          userInputId: question.userInputId,
          reason:
            "This client does not support native question dialogs. Ask the user in chat instead.",
        });
      });
    }
  };
  // Only read the local SDK fold on the timer, never poll the native server.
  void Effect.runPromise(
    Effect.forever(Effect.sleep(100).pipe(Effect.andThen(Effect.sync(tick)))),
    { signal: abort.signal },
  ).catch(() => {});
  tick();
  return () => {
    abort.abort();
  };
}
