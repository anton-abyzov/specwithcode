import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ComponentProps, ReactNode } from "react";
import type { ModelPickerContent } from "./ModelPickerContent";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import type { ModelEsque } from "./providerIconUtils";

const contentState = vi.hoisted(() => ({
  render: false,
  props: null as ComponentProps<typeof ModelPickerContent> | null,
}));
vi.mock("../ui/popover", async (original) => ({
  ...(await original<typeof import("../ui/popover")>()),
  PopoverPopup: ({ children }: { children: ReactNode }) =>
    contentState.render ? <div>{children}</div> : null,
}));
vi.mock("./ModelPickerContent", async (original) => ({
  ...(await original<typeof import("./ModelPickerContent")>()),
  ModelPickerContent: (props: ComponentProps<typeof ModelPickerContent>) => {
    contentState.props = props;
    return null;
  },
}));
afterEach(() => {
  contentState.render = false;
  contentState.props = null;
});

function providerEntry(instanceId: string, driver: string) {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider])[0]!;
}

function renderPicker(input: {
  instanceId: string;
  driver: string;
  model: string;
  options: ReadonlyArray<ModelEsque>;
  includeEntry?: boolean;
  triggerLabel?: string;
}) {
  const instanceId = ProviderInstanceId.make(input.instanceId);
  const entry = providerEntry(input.instanceId, input.driver);
  return renderToStaticMarkup(
    <ProviderModelPicker
      activeInstanceId={instanceId}
      model={input.model}
      lockedProvider={null}
      instanceEntries={input.includeEntry === false ? [] : [entry]}
      modelOptionsByInstance={new Map([[instanceId, input.options]])}
      onInstanceModelChange={() => {}}
      {...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {})}
    />,
  );
}

describe("ProviderModelPicker", () => {
  it("shows a neutral aggregate value without a representative model or availability badge", () => {
    const markup = renderPicker({
      instanceId: "codex_personal",
      driver: "codex",
      model: "gpt-5",
      options: [{ slug: "gpt-5", name: "GPT 5", isUnavailable: true }],
      triggerLabel: "Mixed values",
    });
    expect(markup).toContain("Mixed values");
    expect(markup).not.toContain("GPT 5");
    expect(markup).not.toContain("Unavailable");
  });

  it.each(["", ANTIGRAVITY_DEFAULT_MODEL])(
    "shows a choice prompt before Antigravity has an account catalog for %s",
    (model) => {
      const markup = renderPicker({
        instanceId: "antigravity",
        driver: "antigravity",
        model,
        options: [],
      });

      expect(markup).toContain("Choose model");
      expect(markup).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each([{ aliases: [ANTIGRAVITY_DEFAULT_MODEL] }, { isDefault: true }])(
    "shows the actual default model for an Antigravity marker with %j",
    (defaultMetadata) => {
      const markup = renderPicker({
        instanceId: "google_work",
        driver: "antigravity",
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [
          { slug: "gemini-fast", name: "Gemini Fast" },
          { slug: "gemini-pro", name: "Gemini Pro", ...defaultMetadata },
        ],
      });

      expect(markup).toContain("Gemini Pro");
      expect(markup).not.toContain("Gemini Fast");
      expect(markup).not.toContain(ANTIGRAVITY_DEFAULT_MODEL);
    },
  );

  it.each(["opencode", "antigravity"])(
    "keeps the selected model label when the %s account catalog does not contain it",
    (driver) => {
      const markup = renderPicker({
        instanceId: "team_runtime",
        driver,
        model: "missing-model",
        options: [{ slug: "fallback", name: "Fallback model" }],
      });

      expect(markup).toContain("missing-model");
      expect(markup).not.toContain("Fallback model");
    },
  );

  it.each(["codex", "claudeAgent", "cursor", "grok"])(
    "uses the first option label for a missing %s model",
    (driver) => {
      const markup = renderPicker({
        instanceId: `${driver}_work`,
        driver,
        model: "missing-model",
        options: [{ slug: "fallback-model", name: "Fallback model" }],
      });

      expect(markup).toContain("Fallback model");
      expect(markup).not.toContain(">missing-model<");
    },
  );

  it("prefers a matching model for OpenCode", () => {
    const markup = renderPicker({
      instanceId: "custom_runtime",
      driver: "opencode",
      model: "openrouter/selected",
      options: [
        { slug: "openrouter/fallback", name: "Fallback model" },
        { slug: "openrouter/selected", name: "Selected model" },
      ],
    });

    expect(markup).toContain("Selected model");
    expect(markup).not.toContain("Fallback model");
  });

  it("uses the first option when the active instance entry is missing", () => {
    const markup = renderPicker({
      instanceId: "missing_instance",
      driver: "opencode",
      model: "missing-model",
      options: [{ slug: "fallback-model", name: "Fallback model" }],
      includeEntry: false,
    });

    expect(markup).toContain("Fallback model");
    expect(markup).not.toContain(">missing-model<");
  });

  it("keeps instance initials visible in the resting trigger", () => {
    const activeEntry = providerEntry("codex_personal", "codex");
    const markup = renderToStaticMarkup(
      <ProviderModelPicker
        activeInstanceId={activeEntry.instanceId}
        model="gpt-5"
        lockedProvider={null}
        instanceEntries={[providerEntry("codex", "codex"), activeEntry]}
        modelOptionsByInstance={new Map()}
        size="xs"
        onInstanceModelChange={() => {}}
      />,
    );

    expect(markup).toContain(">CP</span>");
  });
});

describe("ProviderModelPicker setup callbacks", () => {
  function renderCallbacks(input: { disabled?: boolean; manage?: boolean } = {}) {
    contentState.render = true;
    const onManageProviders = vi.fn();
    const onOpenProviderSetup = vi.fn();
    const entry = providerEntry("copilot", "acpRegistry");
    renderToStaticMarkup(
      <ProviderModelPicker
        activeInstanceId={entry.instanceId}
        model="default"
        unset
        lockedProvider={null}
        instanceEntries={[entry]}
        modelOptionsByInstance={new Map()}
        disabled={input.disabled ?? false}
        onOpenProviderSetup={onOpenProviderSetup}
        {...(input.manage ? { onManageProviders } : {})}
        onInstanceModelChange={() => {}}
      />,
    );
    return { onManageProviders, onOpenProviderSetup, props: contentState.props! };
  }

  it("passes a dedicated management destination separately from instance repair", () => {
    const { props, onManageProviders, onOpenProviderSetup } = renderCallbacks({ manage: true });
    props.onManageProviders!();
    expect(onManageProviders).toHaveBeenCalledOnce();
    expect(onOpenProviderSetup).not.toHaveBeenCalled();
    props.onOpenProviderSetup!(ProviderInstanceId.make("gemini"));
    expect(onOpenProviderSetup).toHaveBeenCalledWith("gemini");
  });

  it("gives existing picker callers a management action through their setup destination", () => {
    const { props, onOpenProviderSetup } = renderCallbacks();
    props.onManageProviders!();
    expect(onOpenProviderSetup).toHaveBeenCalledWith("copilot");
  });

  it("does not navigate when an already-open picker becomes disabled", () => {
    const { props, onManageProviders, onOpenProviderSetup } = renderCallbacks({
      disabled: true,
      manage: true,
    });
    props.onManageProviders!();
    props.onOpenProviderSetup!(ProviderInstanceId.make("gemini"));
    expect(onManageProviders).not.toHaveBeenCalled();
    expect(onOpenProviderSetup).not.toHaveBeenCalled();
  });
});

it("keeps fallback state inside the running model trigger and names the original pick", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const header = {
    title: "Fallback for Claude Code · Opus 5.5",
    detail: "Opus 5.5 hit its usage limit and resets at 3:40 PM.",
    back: null,
  };
  contentState.render = true;
  const markup = renderToStaticMarkup(
    <ProviderModelPicker
      activeInstanceId={instanceId}
      model="gpt-6.1-sol"
      lockedProvider={null}
      instanceEntries={[providerEntry("codex", "codex")]}
      modelOptionsByInstance={
        new Map([[instanceId, [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }]]])
      }
      onInstanceModelChange={() => {}}
      triggerParts={{ provider: "Codex", model: "GPT-6.1-Sol" }}
      triggerState={{
        kind: "fallback",
        pick: "Claude Code · Opus 5.5",
        pickModel: "Opus 5.5",
        reason: "usage limit",
      }}
      triggerStateDetail={header.detail}
      stateHeader={header}
    />,
  );
  expect(markup).toMatch(
    /<button[^>]*data-chat-provider-model-picker[^>]*>[\s\S]*sws-model-state[\s\S]*<\/button>/,
  );
  expect(markup).toContain("fallback for Claude Code · Opus 5.5 (usage limit, resets 3:40 PM)");
  expect(contentState.props?.stateHeader).toBe(header);
});
