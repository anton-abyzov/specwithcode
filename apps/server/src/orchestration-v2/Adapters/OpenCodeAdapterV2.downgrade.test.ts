import { assert, describe, it } from "@effect/vitest";

import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import { openCodeChildPermissionRules, openCodePermissionRules } from "./OpenCodeAdapterV2.ts";

type Rules = ReturnType<typeof openCodePermissionRules>;

const policy = (runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"]) =>
  ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
  });

/** OpenCode applies the last rule that matches. */
const action = (rules: Rules, permission: string) =>
  rules.findLast((rule) => rule.permission === "*" || rule.permission === permission)?.action;

describe("OpenCode Task child after a thread is lowered", () => {
  it("does not keep the external_directory allow its parent once had", () => {
    // A child session copies its parent's external_directory and deny rules;
    // a parent created in a wider mode carries the allow.
    const inherited = [
      { permission: "external_directory", pattern: "*", action: "allow" } as const,
    ];
    const child = openCodeChildPermissionRules(policy("approval-required"), inherited);
    assert.equal(action(child, "external_directory"), "ask");
    assert.equal(action(child, "bash"), "ask");
  });

  it("keeps its own external_directory deny under Full access", () => {
    const deny = { permission: "external_directory", pattern: "*", action: "deny" } as const;
    const child = openCodeChildPermissionRules(policy("full-access"), [deny]);
    assert.equal(action(child, "external_directory"), "deny");
  });

  it("keeps its own external_directory ask under Full access", () => {
    const ask = { permission: "external_directory", pattern: "*", action: "ask" } as const;
    const child = openCodeChildPermissionRules(policy("full-access"), [ask]);
    assert.equal(action(child, "external_directory"), "ask");
  });
});
