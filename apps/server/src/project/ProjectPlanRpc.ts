import {
  ProjectPlanError,
  WS_METHODS,
  WsProjectPlanLinkRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProjectPlanService from "./ProjectPlanService.ts";
import { renderPlanMarkdown } from "./plan/renderPlanMarkdown.ts";

export const handlers = Effect.gen(function* () {
  const plans = yield* ProjectPlanService.ProjectPlanService;
  return {
    [WS_METHODS.projectsPlanRead]: plans.read,
    [WS_METHODS.projectsPlanAuthorityRead]: plans.readAuthority,
    [WS_METHODS.projectsPlanReplace]: (input: Omit<Parameters<typeof plans.replace>[0], "actor">) =>
      plans.replace({ ...input, actor: { kind: "user" } }),
    [WS_METHODS.projectsPlanConfigure]: (
      input: Omit<Parameters<typeof plans.configure>[0], "actor">,
    ) => plans.configure({ ...input, actor: { kind: "user" } }),
    [WS_METHODS.projectsPlanClaim]: (input: Omit<Parameters<typeof plans.claim>[0], "actor">) =>
      plans.claim({ ...input, actor: { kind: "user" } }),
    [WS_METHODS.projectsPlanRelease]: (input: Omit<Parameters<typeof plans.release>[0], "actor">) =>
      plans.release({ ...input, actor: { kind: "user" } }),
    [WS_METHODS.projectsPlanReport]: (input: Omit<Parameters<typeof plans.report>[0], "actor">) =>
      plans.report({ ...input, actor: { kind: "user" } }),
    [WS_METHODS.projectsPlanVerify]: (input: Omit<Parameters<typeof plans.verify>[0], "actor">) =>
      plans.verify({ ...input, actor: { kind: "user" } }),
    [WS_METHODS.projectsPlanExport]: (input: Parameters<typeof plans.read>[0]) =>
      Effect.gen(function* () {
        const snapshot = yield* plans.read(input);
        if (!snapshot.native)
          return yield* new ProjectPlanError({ projectId: input.projectId, code: "read_only" });
        return {
          filename: "project-plan.md" as const,
          content: renderPlanMarkdown(snapshot.native),
        };
      }),
  };
});

/** The `projectLink.plan*` handlers (see `WsProjectPlanLinkRpcGroup`). */
export const layerLinkRpcHandlers = WsProjectPlanLinkRpcGroup.middleware(
  RpcInstrumentation,
).toLayer(
  Effect.gen(function* () {
    const plans = yield* ProjectPlanService.ProjectPlanService;
    return {
      [WS_METHODS.projectLinkPlanExport]: plans.exportLinked,
      [WS_METHODS.projectLinkPlanMerge]: plans.mergeLinked,
    };
  }),
);
