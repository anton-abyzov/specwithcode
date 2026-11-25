/**
 * chrome_sign_in_needed (1488): an agent that meets a sign-in page asks the
 * person to sign in themselves. A card in the agent's thread opens a live
 * view of a tab only the person sees and drives; the agent waits and hears
 * only how it ended. It never sees the page, the address history or a key.
 *
 * @module signInTool
 */
import {
  type AccessRequestSubject,
  BrowserExtensionToolError,
  type BrowserSignInOutcome,
  type ChromeSignInNeededInput,
  type ChromeSignInNeededResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { IMPLICIT_ACCESS_TIMEOUT_MS, thisMachineLabel } from "../../../access/accessGate.ts";
import * as BrowserExtension from "../../../browserExtension/BrowserExtension.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";

/** One call waits this long for the person; then the agent calls again with the same id. */
export const SIGN_IN_WAIT_MS = 4 * 60_000;

export const SIGN_IN_SUBJECT_DETAIL = "A new Chrome tab, held for you until you press Done.";

const MESSAGES: Record<BrowserSignInOutcome | "signing_in", string> = {
  done: "The user signed in and pressed Done. The tab is open in that Chrome profile again; carry on with the chrome_* tools.",
  cancelled:
    "The user cancelled the sign-in and the tab was closed. Do not ask again in this turn; tell the user what the task needed it for.",
  timed_out:
    "The sign-in view closed after ten minutes with nothing done in it, and its tab was closed. Tell the user the task still needs the sign-in.",
  tab_closed: "The sign-in tab was closed in Chrome before the user pressed Done.",
  declined:
    "The user chose Not now. Do not ask again in this turn; tell the user what the task needed the sign-in for.",
  expired:
    "Nobody opened the sign-in in time. Tell the user the task still needs it, and ask again when they are back.",
  signing_in:
    "The user is still signing in. Call chrome_sign_in_needed again with the same clientRequestId to keep waiting; do not use the Chrome profile meanwhile.",
};

const answer = (status: BrowserSignInOutcome | "signing_in"): ChromeSignInNeededResult => ({
  status,
  message: MESSAGES[status],
});

const refused = (reason: string) =>
  new BrowserExtensionToolError({ code: "invalid_request", reason });

export const signInNeeded = (
  scope: McpInvocationScope & { readonly thread: { readonly threadId: string } },
  input: ChromeSignInNeededInput,
) =>
  Effect.gen(function* () {
    const extension = yield* BrowserExtension.BrowserExtension;
    if (extension.hub.profiles().length === 0)
      return yield* new BrowserExtensionToolError({
        code: "not_connected",
        reason:
          "chrome_sign_in_needed uses this machine's Chrome, and no Chrome profile is paired here. Run it from a thread on the machine whose Chrome needs the sign-in.",
      });
    const asked = yield* Effect.try({
      try: () =>
        extension.signIn.ask({
          threadId: scope.thread.threadId,
          clientRequestId: input.clientRequestId,
          url: input.url,
          profile: input.profile,
        }),
      catch: (error) => refused(error instanceof Error ? error.message : "Not a sign-in page."),
    });
    if (asked.outcome !== null) return answer(asked.outcome);
    if (!asked.allowed) {
      const machine = (yield* thisMachineLabel) ?? "this machine";
      const host = new URL(asked.origin).host;
      const subject: AccessRequestSubject = {
        kind: "sign-in",
        key: `sign-in:${asked.requestId}`,
        label: host,
        detail: SIGN_IN_SUBJECT_DETAIL,
        hostLabel: machine,
      };
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const card = yield* service.requestAccess(scope, {
        accessTitle: `Sign-in needed on ${machine}: ${host}`,
        reason: input.reason,
        subjects: [subject],
        timeoutMs: IMPLICIT_ACCESS_TIMEOUT_MS,
        clientRequestId: `sign-in:${input.clientRequestId}`,
      });
      if (card.status !== "allowed") {
        extension.signIn.decline(
          asked.requestId,
          card.status === "denied" ? "declined" : "expired",
        );
        return answer(card.status === "denied" ? "declined" : "expired");
      }
      extension.signIn.allow(asked.requestId);
    }
    const ended = yield* Effect.promise(() =>
      extension.signIn.waitForEnd(asked.requestId, SIGN_IN_WAIT_MS).catch(() => "expired" as const),
    );
    return answer(ended ?? "signing_in");
  });
