// @effect-diagnostics nodeBuiltinImport:off - a test that reads the bundled icon sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import {
  GITHUB_COPILOT_ICON_PATHS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProviderInstanceSettings, deriveProviderInstanceEntries } from "../providerInstances";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { GitHubCopilotIcon } from "./GitHubCopilotIcon";

const repoRoot = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));
const acpRegistry = ProviderDriverKind.make("acpRegistry");
const copilotIconUrl =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg";

function expectCanonicalCopilot(markup: string) {
  expect(markup).toContain('data-provider-icon="github-copilot"');
  expect(markup).toContain('viewBox="0 0 16 16"');
  for (const d of GITHUB_COPILOT_ICON_PATHS) expect(markup).toContain(d);
  // No remote image, no generic ACP fallback, no second glyph.
  expect(markup).not.toContain("<img");
  expect(markup.match(/<svg/g)).toHaveLength(1);
}

describe("Copilot icon", () => {
  it("renders the official GitHub Copilot mark", () => {
    expectCanonicalCopilot(renderToStaticMarkup(<GitHubCopilotIcon />));
  });

  it.each([
    ["registry identity", { acpRegistryAgentId: "github-copilot-cli" }],
    ["snapshot icon only", { acpRegistryIconUrl: copilotIconUrl }],
    ["both", { acpRegistryAgentId: "github-copilot-cli", acpRegistryIconUrl: copilotIconUrl }],
  ])("is canonical on provider surfaces given %s", (_name, identity) => {
    expectCanonicalCopilot(
      renderToStaticMarkup(
        <ProviderInstanceIcon
          driverKind={acpRegistry}
          displayName="GitHub Copilot"
          {...identity}
        />,
      ),
    );
  });

  it("is canonical for both a local install and a Studio-managed install", () => {
    const snapshot = (instanceId: string): ServerProvider =>
      ({
        instanceId: ProviderInstanceId.make(instanceId),
        driver: acpRegistry,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "unknown" },
        checkedAt: "2026-10-15T00:00:00.000Z",
        models: [],
      }) as never;
    const entries = applyProviderInstanceSettings(
      deriveProviderInstanceEntries([snapshot("copilot-local"), snapshot("copilot-managed")]),
      {
        providers: {} as never,
        providerInstances: {
          [ProviderInstanceId.make("copilot-local")]: {
            driver: acpRegistry,
            enabled: true,
            config: {
              source: "local",
              agentId: "github-copilot-cli",
              commandPath: "/opt/node/lib/node_modules/@github/copilot-darwin-arm64/copilot",
            },
          },
          [ProviderInstanceId.make("copilot-managed")]: {
            driver: acpRegistry,
            enabled: true,
            config: { agentId: "github-copilot-cli" },
          },
        },
      },
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expectCanonicalCopilot(
        renderToStaticMarkup(
          <ProviderInstanceIcon
            driverKind={entry.driverKind}
            displayName={entry.displayName}
            acpRegistryAgentId={entry.acpRegistryAgentId}
            acpRegistryIconUrl={entry.acpRegistryIconUrl}
          />,
        ),
      );
    }
  });
});

function sourceFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(?:tsx?|svg)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

const PRODUCT_SOURCES = ["apps/web/src", "apps/mobile/src", "apps/desktop/src", "packages"]
  .flatMap((dir) => {
    try {
      return sourceFiles(NodePath.join(repoRoot, dir));
    } catch {
      return [];
    }
  })
  .map((path) => ({
    path: NodePath.relative(repoRoot, path).split(NodePath.sep).join("/"),
    text: NodeFS.readFileSync(path, "utf8"),
  }));

/**
 * Provider icons keyed by a driver alone (option lists, per-driver usage pools)
 * never stand for a single ACP agent. Every other call site must pass the
 * agent identity, or a Copilot entry renders the generic ACP mark.
 */
const DRIVER_ONLY_ICON_SITES = new Set([
  "apps/web/src/components/settings/AddProviderInstanceDialog.tsx",
  "apps/web/src/components/studio/shell/ProjectUsageIndicator.tsx",
  "apps/web/src/components/usage/UsageLimitsPooled.tsx",
  "apps/web/src/components/usage/UsageProviderChart.tsx",
  "apps/web/src/components/usage/UsagePage.tsx",
  "apps/web/src/components/usage/UsageModelDialog.tsx",
  "apps/web/src/components/onboarding/WelcomeWizard.tsx",
]);

describe("Copilot icon sources", () => {
  it("keeps the Copilot glyph in one place", () => {
    const glyphHolders = PRODUCT_SOURCES.filter(({ text }) =>
      GITHUB_COPILOT_ICON_PATHS.some((d) => text.includes(d.slice(0, 40))),
    ).map(({ path }) => path);
    expect(glyphHolders).toEqual(["packages/contracts/src/acpRegistry.ts"]);
    const pathImporters = PRODUCT_SOURCES.filter(({ text }) =>
      /\bGITHUB_COPILOT_ICON_PATHS\b/u.test(text),
    ).map(({ path }) => path);
    expect(pathImporters.toSorted()).toEqual([
      "apps/mobile/src/components/ProviderIcon.tsx",
      "apps/web/src/components/GitHubCopilotIcon.tsx",
      "packages/contracts/src/acpRegistry.ts",
    ]);
    // No bundled Copilot image assets and no retired Octicons glyph.
    expect(PRODUCT_SOURCES.filter(({ path }) => /copilot[^/]*\.svg$/iu.test(path))).toEqual([]);
    expect(PRODUCT_SOURCES.filter(({ text }) => text.includes("M23.922 16.992"))).toEqual([]);
  });

  it("passes ACP identity wherever a provider icon names an instance", () => {
    const missing = PRODUCT_SOURCES.filter(
      ({ path }) => path.startsWith("apps/web/src/") && !DRIVER_ONLY_ICON_SITES.has(path),
    ).flatMap(({ path, text }) =>
      [...text.matchAll(/<(ProviderInstanceIcon|AcpRegistryAgentIcon)\b([\s\S]*?)\/>/gu)]
        .filter(
          ([, , props = ""]) =>
            !/acpRegistryIconUrl|acpRegistryAgentId|\bicon=|\{\.\.\./u.test(props),
        )
        .map((match) => `${path}:${text.slice(0, match.index).split("\n").length}`),
    );
    expect(missing).toEqual([]);
  });
});
