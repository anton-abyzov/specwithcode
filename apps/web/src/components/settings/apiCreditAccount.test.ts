import { expect, it } from "vite-plus/test";

import { apiCreditAccountInstance, isApiCreditAccountDriver } from "./apiCreditAccount";

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
