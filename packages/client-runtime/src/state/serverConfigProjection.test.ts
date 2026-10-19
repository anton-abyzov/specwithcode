import { describe, expect, it } from "@effect/vitest";
import type { ServerConfig, ServerConfigStreamEvent } from "@specweave-studio/contracts";
import * as Option from "effect/Option";

import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withCopilotProviderIcons,
} from "./serverConfigProjection.ts";

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

describe("storage status", () => {
  const low = {
    level: "low",
    freeBytes: 3_200_000_000,
    totalBytes: 994_000_000_000,
    checkedAt: "2026-10-18T12:00:00.000Z",
  } as const;
  const snapshot = (
    fields: { readonly serverVersion?: string; readonly storage?: typeof low },
    environmentId = "env-m4",
  ): ServerConfigStreamEvent =>
    ({
      version: 1,
      type: "snapshot",
      config: {
        environment: {
          environmentId,
          serverVersion: fields.serverVersion ?? "1.0.50",
          capabilities: {},
        },
        providers: [],
        ...(fields.storage === undefined ? {} : { storage: fields.storage }),
      },
    }) as unknown as ServerConfigStreamEvent;
  const storageAfter = (events: ReadonlyArray<ServerConfigStreamEvent>) =>
    events
      .reduce(
        (current, event) => applyServerConfigProjection(current, event),
        Option.none<ServerConfigProjection>(),
      )
      .pipe(
        Option.map((projection) => projection.config.storage),
        Option.getOrUndefined,
      );

  it("follows the status each snapshot carries", () => {
    expect(storageAfter([snapshot({ storage: low })])).toEqual(low);
    const ok = { ...low, level: "ok", freeBytes: 80_000_000_000 } as const;
    expect(storageAfter([snapshot({ storage: low }), snapshot({ storage: ok as never })])).toEqual(
      ok,
    );
  });

  it("keeps the last status while the same build restarts before its first check", () => {
    expect(storageAfter([snapshot({ storage: low }), snapshot({})])).toEqual(low);
  });

  it("keeps the status across other config updates", () => {
    expect(
      storageAfter([
        snapshot({ storage: low }),
        {
          version: 1,
          type: "providerStatuses",
          payload: { providers: [] },
        } as unknown as ServerConfigStreamEvent,
      ]),
    ).toEqual(low);
  });

  it("clears the status for a different build or machine, which may never report one", () => {
    expect(
      storageAfter([snapshot({ storage: low }), snapshot({ serverVersion: "1.0.40" })]),
    ).toBeUndefined();
    expect(storageAfter([snapshot({ storage: low }), snapshot({}, "env-other")])).toBeUndefined();
  });
});
