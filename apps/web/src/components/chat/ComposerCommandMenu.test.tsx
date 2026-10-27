import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ComposerCommandMenu, composerSuggestionOptionId } from "./ComposerCommandMenu";

describe("composerSuggestionOptionId", () => {
  it("keeps whitespace, escape-like paths, and malformed UTF-16 distinct", () => {
    const paths = [
      "docs/my file.md",
      "docs/my_file.md",
      "docs/my%20file.md",
      "docs/my\tfile.md",
      "docs/\ud800.md",
      "docs/\ud801.md",
      "docs/\udc00.md",
      "docs/\ufffd.md",
      "docs/\\ud800.md",
      "docs/\ud83d\ude80.md",
    ];
    const ids = paths.map((path) => composerSuggestionOptionId("suggestions", `path:file:${path}`));

    expect(new Set(ids).size).toBe(paths.length);
    for (const id of ids) expect(id).not.toMatch(/\s|[\ud800-\udfff]/u);
    expect(composerSuggestionOptionId("other-composer", paths[0]!)).not.toBe(
      composerSuggestionOptionId("suggestions", paths[0]!),
    );
  });
});

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
  });

  it("shows the plugin source and the exact invocation for a plugin skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "$browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("$browser");
    expect(markup).not.toContain(">Browser<");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">Plugin Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("<svg");
  });

  it("leads a slash skill with its invocation and keeps a distinct display name", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "$ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).not.toContain("/skill:");
    expect(markup).toMatch(/>\$ask-matt<\/span>/);
    expect(markup).not.toContain(">Ask Matt<");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
  });
  it("shows a provider display name that says more than the id, muted after the invocation", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        listId="test-suggestions"
        items={[
          {
            id: "skill:codex:sw:auto",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "sw:auto",
              displayName: "SpecWeave Auto",
              path: "/Users/maria/.codex/plugins/cache/specweave/sw/3.1.14/skills/auto/SKILL.md",
              enabled: true,
            },
            label: "$sw:auto",
            description: "Run an increment unattended until done",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:sw:auto"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup.indexOf("$sw:auto")).toBeLessThan(markup.indexOf("SpecWeave Auto"));
    expect(markup).toContain(">Plugin</span>");
  });
});
