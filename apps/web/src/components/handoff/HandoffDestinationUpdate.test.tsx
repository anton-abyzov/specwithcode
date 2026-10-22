import type {
  EnvironmentId,
  HandoffPreflightFailure,
  HandoffPreflightResult,
  ServerConfig,
  ThreadId,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  configs: new Map<string, unknown>(),
  update: { status: "idle" } as unknown,
}));

vi.mock("../../branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../branding")>()),
  APP_VERSION: "1.0.70",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { readonly kind: string }) =>
    atom.kind === "update"
      ? state.update
      : {
          _tag: "Success",
          value: { authenticated: true, scopes: ["environment:maintain"] },
        },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    updateStateAtom: (id: string) => ({ kind: "update", id }),
    updateServer: { kind: "updateServer" },
  },
  updateOutdatedServer: { kind: "updateOutdatedServer" },
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: (id: string) => ({ kind: "session", id }) },
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => false,
}));
vi.mock("../../state/entities", () => ({ useServerConfigs: () => state.configs }));

import { HandoffDestinationUpdate } from "./HandoffDestinationUpdate";

const MINIS = "env-minis" as EnvironmentId;

const result = (failures: HandoffPreflightFailure[]): HandoffPreflightResult =>
  ({
    threadId: "thread-1" as ThreadId,
    title: "Fix the build",
    ok: failures.length === 0,
    failures,
    resume: true,
    runEnding: "active",
  }) as HandoffPreflightResult;

const updateMinis: HandoffPreflightFailure = {
  check: "version",
  message:
    "Minis runs SpecWithCode 1.0.66 and M4 runs 1.0.70; they cannot hand off between these versions. Update Minis first.",
};

function render(results: HandoffPreflightResult[]) {
  return renderToStaticMarkup(
    <HandoffDestinationUpdate environmentId={MINIS} label="Minis" results={results} />,
  );
}

beforeEach(() => {
  state.update = { status: "idle" };
  state.configs = new Map([
    [
      MINIS,
      {
        environment: {
          environmentId: MINIS,
          label: "Minis",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "1.0.66",
          capabilities: {
            repositoryIdentity: true,
            serverSelfUpdate: "boot-service",
            desktopAppUpdate: false,
            serverUpdateThreadContinuation: false,
          },
        },
      } satisfies Pick<ServerConfig, "environment">,
    ],
  ]);
});

describe("HandoffDestinationUpdate", () => {
  it("offers to update the destination when its version check names it, once", () => {
    const html = render([result([updateMinis]), result([updateMinis])]);
    expect(html.match(/data-testid="handoff-destination-update"/g)).toHaveLength(1);
    expect(html).toContain("Update Minis");
  });

  it("offers nothing for other failed checks", () => {
    expect(
      render([
        result([
          { check: "ignored-files", message: "Minis: no .env.local" },
          { check: "provider", message: "Minis: Claude not signed in" },
        ]),
      ]),
    ).toBe("");
  });

  it("offers nothing when this machine is the one to update", () => {
    expect(
      render([
        result([
          {
            check: "version",
            message:
              "Minis runs SpecWithCode 1.0.70 and M4 runs 1.0.66; they cannot hand off between these versions. Update M4 first.",
          },
        ]),
      ]),
    ).toBe("");
  });

  it("keeps the desktop-app wording for a destination that cannot update itself", () => {
    const config = state.configs.get(MINIS) as { environment: { capabilities: object } };
    config.environment.capabilities = {
      ...config.environment.capabilities,
      serverSelfUpdate: "desktop-managed",
    };
    expect(render([result([updateMinis])])).toContain(
      "Update the desktop app on that machine to update this server.",
    );
  });
});
