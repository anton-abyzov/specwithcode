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
import { MODEL_CHIP_FITS, ModelChipFitContext } from "./modelChipFit";
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

describe("model chip", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const chip = (extra: Partial<ComponentProps<typeof ProviderModelPicker>> = {}) => (
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
      {...extra}
    />
  );
  const button = (markup: string) => markup.match(/<button[^>]*>/)![0];

  it("names a draft with no provider yet without a dangling separator", () => {
    const markup = renderToStaticMarkup(
      chip({ triggerParts: { provider: "", model: "Choose a model" } }),
    );
    expect(button(markup)).toContain('aria-label="Model: Choose a model. Change model"');
    expect(markup).not.toContain('data-model-chip-part="provider"');
    expect(markup).not.toContain("·");
    expect(markup).toMatch(/data-model-chip-part="model"[^>]*>Choose a model/);
  });

  it("keeps the provider, the model and the state in the accessible name at every fit", () => {
    for (const fit of MODEL_CHIP_FITS) {
      const markup = renderToStaticMarkup(
        chip({
          fit,
          triggerState: { kind: "next", pick: "Claude Code · Opus 5.5", pickModel: "Opus 5.5" },
        }),
      );
      expect(button(markup)).toContain(`data-model-fit="${fit}"`);
      expect(button(markup)).toContain(
        'aria-label="Model: Codex · GPT-6.1-Sol, next message uses Claude Code · Opus 5.5. Change model"',
      );
      // Every part stays mounted, so the next measurement can read it.
      expect(markup).toMatch(/data-model-chip-part="provider"[^>]*>Codex/);
      expect(markup).toMatch(/data-model-chip-part="model"[^>]*>GPT-6.1-Sol/);
      expect(markup).toMatch(/data-model-chip-part="state-full"[^>]*>next: Opus 5.5/);
      expect(markup).toMatch(/data-model-chip-part="state-short"[^>]*>next</);
    }
  });

  it("names the provider beside the model when there is no state", () => {
    const markup = renderToStaticMarkup(chip({ fit: "icon" }));
    expect(button(markup)).toContain('aria-label="Model: Codex · GPT-6.1-Sol. Change model"');
  });

  it("follows the fit its host passes down", () => {
    const markup = renderToStaticMarkup(
      <ModelChipFitContext value="name">{chip()}</ModelChipFitContext>,
    );
    expect(button(markup)).toContain('data-model-fit="name"');
    expect(button(markup)).toContain("data-model-chip");
  });

  it("opens its tooltip from the whole control, so keyboard focus shows it", () => {
    const markup = renderToStaticMarkup(chip({ fit: "full" }));
    expect(button(markup)).toContain('data-slot="tooltip-trigger"');
    expect(button(markup)).toContain("data-chat-provider-model-picker");
  });

  it("gives way only at `name`, where a long model name ends in an ellipsis", () => {
    for (const fit of MODEL_CHIP_FITS) {
      const classes = button(renderToStaticMarkup(chip({ fit }))).match(/class="([^"]*)"/)![1]!;
      const tokens = classes.split(" ");
      if (fit === "name") {
        expect(tokens).toEqual(expect.arrayContaining(["w-auto", "shrink"]));
        expect(tokens).not.toContain("shrink-0");
      } else {
        expect(tokens).toEqual(expect.arrayContaining(["w-max", "shrink-0"]));
      }
    }
  });

  it("keeps the width tiers of a plain picker's state, as while the catalog loads", () => {
    const tiers = "@max-[639px]/composer-surface:[&amp;_.sws-model-state-full]:hidden";
    const state = { kind: "next", pick: "Claude Code · Opus 5.5" } as const;
    const plain = renderToStaticMarkup(
      <ProviderModelPicker
        activeInstanceId={instanceId}
        model="gpt-6.1-sol"
        lockedProvider={null}
        instanceEntries={[providerEntry("codex", "codex")]}
        modelOptionsByInstance={
          new Map([[instanceId, [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }]]])
        }
        onInstanceModelChange={() => {}}
        triggerState={state}
      />,
    );
    expect(plain).toContain(tiers);
    expect(renderToStaticMarkup(chip({ fit: "full", triggerState: state }))).not.toContain(tiers);
  });

  it("leaves a picker without provider and model parts as it was", () => {
    const markup = renderToStaticMarkup(chip({ triggerLabel: "Mixed values" }));
    expect(button(markup)).not.toContain("data-model-fit");
    expect(markup).not.toContain("data-model-chip-part");
  });
});
