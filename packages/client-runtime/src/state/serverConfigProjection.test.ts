import { describe, expect, it } from "@effect/vitest";
import type { ServerConfig, ServerConfigStreamEvent } from "@specweave-studio/contracts";
import * as Option from "effect/Option";

import { applyServerConfigProjection, withCopilotProviderIcons } from "./serverConfigProjection.ts";

const copilotIconUrl =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg";

const provider = (instanceId: string, iconUrl?: string) => ({
  instanceId,
  driver: "acpRegistry",
  ...(iconUrl ? { iconUrl } : {}),
});

const config = (providers: ReadonlyArray<ReturnType<typeof provider>>) =>
  ({
    providers,
    settings: {
      providerInstances: {
        "copilot-local": {
          driver: "acpRegistry",
          config: {
            source: "local",
            agentId: "github-copilot-cli",
            commandPath: "/opt/node/lib/node_modules/@github/copilot-darwin-arm64/copilot",
          },
        },
        "copilot-managed": { driver: "acpRegistry", config: { agentId: "github-copilot-cli" } },
        gemini: { driver: "acpRegistry", config: { agentId: "gemini" } },
      },
    },
  }) as unknown as ServerConfig;

describe("withCopilotProviderIcons", () => {
  it("names every configured Copilot instance even when a snapshot omits its icon", () => {
    const result = withCopilotProviderIcons(
      config([provider("copilot-local"), provider("copilot-managed"), provider("gemini")]),
    );
    expect(result.providers.map((entry) => entry.iconUrl)).toEqual([
      copilotIconUrl,
      copilotIconUrl,
      undefined,
    ]);
  });

  it("returns the same config when nothing changes", () => {
    const current = config([provider("copilot-managed", copilotIconUrl), provider("gemini")]);
    expect(withCopilotProviderIcons(current)).toBe(current);
  });

  it("applies to provider status updates from an older server", () => {
    const current = Option.some({
      config: config([]),
      latestEvent: { type: "snapshot" } as unknown as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "providerStatuses",
      payload: { providers: [provider("copilot-local")] },
    } as unknown as ServerConfigStreamEvent);
    expect(Option.getOrThrow(next).config.providers[0]?.iconUrl).toBe(copilotIconUrl);
  });
});
