// Headless fixture: the production Settings › General › New threads Model row over three
// synthetic providers (Claude Code with effort, Fast mode and Ultracode; GitHub Copilot
// with effort only; Codex with reasoning and a Fast service tier).
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { createRoot } from "react-dom/client";

import { ProjectDefaultsSettings } from "~/components/settings/ProjectDefaultsSettings";
import { ToastProvider } from "~/components/ui/toast";
import { fixtureState } from "./mocks";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const level = (id: string, label: string) => ({ id, label });
function provider(
  id: string,
  driver: string,
  name: string,
  slug: string,
  model: string,
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(driver),
    displayName: name,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-08T20:00:00.000Z",
    version: null,
    models: [{ slug, name: model, isCustom: false, capabilities: { optionDescriptors } }],
    slashCommands: [],
    skills: [],
    ...(driver === "acpRegistry"
      ? { iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg" }
      : {}),
  };
}

const providers = [
  provider("claudeAgent", "claudeAgent", "Claude Code", "claude-opus-5-5", "Claude Opus 5.5", [
    {
      id: "effort",
      label: "Effort",
      type: "select",
      options: [
        level("low", "Low"),
        level("medium", "Medium"),
        level("high", "High"),
        level("xhigh", "Extra High"),
        level("max", "Max"),
      ],
    },
    { id: "fastMode", label: "Fast Mode", type: "boolean" },
    {
      id: "ultracode",
      label: "Ultracode",
      description: "Multi-agent workflows on every task, at any effort",
      type: "boolean",
    },
  ]),
  provider(
    "acpRegistry_copilot",
    "acpRegistry",
    "GitHub Copilot",
    "claude-opus-5.5",
    "Claude Opus 5.5",
    [
      {
        id: "reasoning_effort",
        label: "Reasoning effort",
        type: "select",
        options: [
          level("low", "low"),
          level("medium", "medium"),
          level("high", "high"),
          level("xhigh", "xhigh"),
        ],
      },
    ],
  ),
  provider("codex", "codex", "Codex", "gpt-5.5", "GPT-5.5", [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [level("medium", "Medium"), level("high", "High"), level("xhigh", "Extra High")],
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [{ id: "default", label: "Standard", isDefault: true }, level("priority", "Fast")],
    },
  ]),
];

const start = params.get("start") ?? "claude";
fixtureState.set({
  providers,
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    // Copilot is a configured registry agent, so it is an explicit instance.
    providerInstances: {
      [ProviderInstanceId.make("acpRegistry_copilot")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: true,
        config: { agentId: "github-copilot-cli", source: "registry" },
      },
    },
    defaultModelSelection:
      start === "copilot"
        ? {
            instanceId: ProviderInstanceId.make("acpRegistry_copilot"),
            model: "claude-opus-5.5",
            options: [{ id: "reasoning_effort", value: "xhigh" }],
          }
        : {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5-5",
            options: [
              { id: "effort", value: "xhigh" },
              { id: "fastMode", value: true },
              { id: "ultracode", value: true },
            ],
          },
  },
});
// The verifier reads what the row saved.
Object.assign(window, { fixtureState });

createRoot(document.getElementById("root")!).render(
  <ToastProvider>
    <div className="mx-auto max-w-3xl p-6">
      <ProjectDefaultsSettings category="general" />
    </div>
  </ToastProvider>,
);
