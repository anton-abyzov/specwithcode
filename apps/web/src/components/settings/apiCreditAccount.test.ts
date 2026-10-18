import { expect, it } from "vite-plus/test";

import {
  apiCreditAccountInstance,
  CLAUDE_WORKSPACE_ID_PATTERN,
  isApiCreditAccountDriver,
} from "./apiCreditAccount";

it("makes one instance per API account, its key kept as a sensitive variable", () => {
  const first = apiCreditAccountInstance({
    driver: "claudeAgent",
    label: " Hackathon #1 ",
    apiKey: " sk-ant-test ",
    existingIds: new Set(["claudeAgent"]),
  });
  expect(first).toEqual({
    instanceId: "claudeAgent_hackathon_1",
    instance: {
      driver: "claudeAgent",
      enabled: true,
      displayName: "Hackathon #1",
      environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-test", sensitive: true }],
    },
  });
  // A second account with the same name never replaces the first.
  expect(
    apiCreditAccountInstance({
      driver: "claudeAgent",
      label: "Hackathon #1",
      apiKey: "sk-ant-other",
      existingIds: new Set(["claudeAgent_hackathon_1"]),
    }).instanceId,
  ).toBe("claudeAgent_hackathon_1_2");
  const grok = apiCreditAccountInstance({
    driver: "grok",
    label: "",
    apiKey: "xai-test",
    existingIds: new Set(),
  });
  expect(grok.instanceId).toBe("grok_api");
  expect(grok.instance.displayName).toBe("Grok API");
  expect(grok.instance.environment).toEqual([
    { name: "XAI_API_KEY", value: "xai-test", sensitive: true },
  ]);
  expect(["claudeAgent", "grok", "codex", "cursor"].map(isApiCreditAccountDriver)).toEqual([
    true,
    true,
    false,
    false,
  ]);
});

it("sends the workspace of a key that is not scoped to one as a Claude request header", () => {
  const scoped = apiCreditAccountInstance({
    driver: "claudeAgent",
    label: "Personal",
    apiKey: "sk-ant-usr-test",
    workspaceId: " wrkspc_01AbC ",
    existingIds: new Set(),
  });
  expect(scoped.instance.environment).toEqual([
    { name: "ANTHROPIC_API_KEY", value: "sk-ant-usr-test", sensitive: true },
    {
      name: "ANTHROPIC_CUSTOM_HEADERS",
      value: "anthropic-workspace-id: wrkspc_01AbC",
      sensitive: false,
    },
  ]);
  // Blank, or a driver that has no workspaces: nothing extra.
  expect(
    apiCreditAccountInstance({
      driver: "claudeAgent",
      label: "",
      apiKey: "sk-ant-api03-test",
      workspaceId: "  ",
      existingIds: new Set(),
    }).instance.environment,
  ).toHaveLength(1);
  expect(
    apiCreditAccountInstance({
      driver: "grok",
      label: "",
      apiKey: "xai-test",
      workspaceId: "wrkspc_01AbC",
      existingIds: new Set(),
    }).instance.environment,
  ).toHaveLength(1);
  // A newline would let the value add a second header line.
  expect(
    ["wrkspc_01AbC", "default", "wrkspc_", "wrkspc_01 x", "wrkspc_01\nx-other: 1"].map((v) =>
      CLAUDE_WORKSPACE_ID_PATTERN.test(v),
    ),
  ).toEqual([true, false, false, false, false]);
});
