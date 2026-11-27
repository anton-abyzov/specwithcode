import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@specweave-studio/contracts";

import { specweaveAgentEnvironment } from "../../../provider/RuntimeInstructions.ts";
import { ledgerWriteEnvironment, specweaveToolForInstance } from "./identity.ts";

const id = ProviderInstanceId.make;
const driver = ProviderDriverKind.make;

describe("specweaveToolForInstance (1497)", () => {
  it("gives built-in instances the slug their adapter passes", () => {
    const settings = { providerInstances: {} };
    expect(specweaveToolForInstance(settings, id("claudeAgent"))).toBe("claude");
    expect(specweaveToolForInstance(settings, id("codex"))).toBe("codex");
    expect(specweaveToolForInstance(settings, id("opencode"))).toBe("opencode");
    expect(specweaveToolForInstance(settings, id("pi"))).toBe("pi");
  });

  it("follows the driver of a named instance, such as a second Claude account", () => {
    const settings = {
      providerInstances: { [id("claude-work")]: { driver: driver("claudeAgent") } },
    };
    expect(specweaveToolForInstance(settings, id("claude-work"))).toBe("claude");
  });

  it("names a registry ACP agent SpecWeave knows, and refuses the rest", () => {
    const acp = (config: unknown) => ({
      providerInstances: { [id("acp")]: { driver: driver("acpRegistry"), config } },
    });
    expect(specweaveToolForInstance(acp({ agentId: "github-copilot-cli" }), id("acp"))).toBe(
      "copilot",
    );
    expect(
      specweaveToolForInstance(acp({ source: "registry", agentId: "gemini" }), id("acp")),
    ).toBe("gemini");
    expect(specweaveToolForInstance(acp({ agentId: "some-new-agent" }), id("acp"))).toBeNull();
    expect(
      specweaveToolForInstance(
        acp({ source: "local", agentId: "github-copilot-cli", commandPath: "/x/copilot" }),
        id("acp"),
      ),
    ).toBeNull();
    expect(specweaveToolForInstance(acp(undefined), id("acp"))).toBeNull();
  });

  it("refuses a provider whose processes have no SpecWeave slug of their own", () => {
    const settings = { providerInstances: {} };
    expect(specweaveToolForInstance(settings, id("cursor"))).toBeNull();
    expect(specweaveToolForInstance(settings, id("unknown-thing"))).toBeNull();
  });
});

describe("ledgerWriteEnvironment (1497)", () => {
  it("is the thread's own SpecWeave variables, with no session id and no agent override", () => {
    const environment = ledgerWriteEnvironment({ threadId: "thread-1", tool: "codex" });
    expect(environment).toMatchObject(
      specweaveAgentEnvironment({ threadId: "thread-1", tool: "codex" }),
    );
    expect(environment).toMatchObject({
      SPECWEAVE_SESSION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
      CODEX_SESSION_ID: "",
    });
    expect(environment).not.toHaveProperty("SPECWEAVE_AGENT");
  });
});
