// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type SkillAuthoringDraft,
  type SkillAuthoringResult,
} from "@specweave-studio/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { SkillAuthoringForm, skillMarkdown, type AuthoringRequest } from "./SkillAuthoringSheet";
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { skillAuthoring: {} } }));
vi.mock("../studio/shell/ModelBadge", () => ({ useProviderEntries: () => new Map() }));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: (props: {
    onInstanceModelChange: (id: ProviderInstanceId, model: string) => void;
  }) => (
    <button
      onClick={() => props.onInstanceModelChange(ProviderInstanceId.make("codex"), "chosen-model")}
    >
      Choose fixture model
    </button>
  ),
}));
vi.mock("../ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock("../ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));
const fixtureDraft: SkillAuthoringDraft = {
  id: "12345678-1234-1234-1234-123456789abc",
  revision: 2,
  updatedAt: "2026-11-04T00:00:00Z",
  name: "review-code",
  description: "Review changes",
  instructions: "Read changes and cite findings.",
  version: "1.0.0",
  prompt: "Review code",
};
const agent = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Fixture Codex",
  enabled: true,
  installed: true,
  isAvailable: true,
  isDefault: true,
  models: [{ slug: "chosen-model", name: "Chosen model", isCustom: false, capabilities: null }],
  snapshot: { auth: { status: "authenticated", email: "fixture@example.invalid" }, models: [] },
} as unknown as ProviderInstanceEntry;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
function button(text: string) {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function fill(label: string, value: string) {
  const input = host.querySelector(`[aria-label="${label}"]`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  await act(async () => {
    const proto =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function mount(
  request: (input: AuthoringRequest) => Promise<SkillAuthoringResult>,
  onOpenChange = vi.fn(),
  seed?: import("./skillAuthoringSeed").SkillAuthoringSeed,
) {
  await act(async () =>
    root.render(
      <SkillAuthoringForm
        open
        seed={seed}
        onOpenChange={onOpenChange}
        machineLabel="Fixture machine"
        cwd="/fixture/project"
        initialInstanceId="codex"
        agents={[agent]}
        request={request}
        canWrite
        canGenerate
        canPublish
      />,
    ),
  );
}
describe("skill authoring", () => {
  it("renders exact quoted metadata and instructions", () => {
    expect(skillMarkdown(fixtureDraft)).toBe(
      '---\nname: "review-code"\ndescription: "Review changes"\nmetadata:\n  version: "1.0.0"\n---\n\nRead changes and cite findings.\n',
    );
  });
  it("manual edits save before close and do not run a model", async () => {
    const request = vi.fn(async (input: AuthoringRequest) => ({
      draft:
        input.operation === "read"
          ? fixtureDraft
          : { ...fixtureDraft, ...input.draft, revision: 3 },
    }));
    const close = vi.fn();
    await mount(request, close);
    await fill("Instructions and examples", "Keep my manual edits.");
    await click("Close");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["read", "save"]);
    expect(request.mock.calls[1]?.[0].draft?.instructions).toBe("Keep my manual edits.");
    expect(close).toHaveBeenCalledWith(false);
  });
  it("generation uses the explicitly chosen model and preserves text after failure", async () => {
    const request = vi.fn(async (input: AuthoringRequest) => {
      if (input.operation === "generate") throw new Error("Selected provider unavailable");
      return { draft: fixtureDraft };
    });
    await mount(request);
    await click("1. Describe");
    await click("Choose fixture model");
    await fill("What should this skill do?", "Keep this generation prompt");
    await click("Generate draft");
    const generated = request.mock.calls.find(([input]) => input.operation === "generate")?.[0];
    expect(generated?.draft?.modelSelection).toEqual({
      instanceId: "codex",
      model: "chosen-model",
    });
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(
      "Keep this generation prompt",
    );
    expect(host.textContent).toContain("Selected provider unavailable");
  });
  it("keeps reviewed content when regeneration is declined", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const request = vi.fn(async () => ({ draft: fixtureDraft }));
    await mount(request);
    await click("1. Describe");
    await click("Choose fixture model");
    await fill("What should this skill do?", "Replace this");
    await click("Generate draft");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("requires explicit public consent and uses the saved revision for publication", async () => {
    const request = vi.fn(async (input: AuthoringRequest) => ({
      draft:
        input.operation === "save"
          ? { ...fixtureDraft, ...input.draft, revision: 3 }
          : fixtureDraft,
    }));
    await mount(request);
    await fill("Instructions and examples", "Revised instructions");
    await fill("GitHub repository", "fixture/skills");
    await act(async () =>
      (host.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click(),
    );
    expect(button("Publish for review").disabled).toBe(true);
    await act(async () =>
      (host.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
    );
    await click("Publish for review");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual([
      "read",
      "save",
      "publish",
    ]);
    expect(request.mock.calls[2]?.[0]).toMatchObject({
      revision: 3,
      publication: { repository: "fixture/skills", visibility: "public" },
    });
  });
  it("resumes the queue without resubmitting and keeps Apply unavailable", async () => {
    const draft = {
      ...fixtureDraft,
      publication: {
        state: "queued" as const,
        contentHash: "hash",
        version: "1.0.0",
        skillId: "fixture/skills/review-code",
        skillPath: "skills/review-code/SKILL.md",
        repository: "fixture/skills",
        visibility: "private" as const,
        submissionId: "receipt",
      },
    };
    const request = vi.fn(async (_input: AuthoringRequest) => ({ draft }));
    await mount(request);
    expect(host.textContent).toContain("Queued for review");
    expect(button("3. Apply").disabled).toBe(true);
    await click("Check status");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["read", "status"]);
    expect(host.textContent).not.toContain("Publish for review");
  });
  it("invalidates a preview when scope changes and sends the selected instance", async () => {
    const draft = {
      ...fixtureDraft,
      publication: {
        state: "published" as const,
        contentHash: "hash",
        version: "1.0.0",
        skillId: "fixture/skills/review-code",
        skillPath: "skills/review-code/SKILL.md",
        repository: "fixture/skills",
        visibility: "private" as const,
      },
    };
    const request = vi.fn(async (input: AuthoringRequest): Promise<SkillAuthoringResult> => ({
      draft,
      ...(["previewApply", "apply"].includes(input.operation)
        ? {
            applyResult: {
              preview: input.operation === "previewApply",
              expectedHash: `preview-${input.apply?.scope}`,
              files: ["/fixture/SKILL.md"],
              summary: "Version installed",
              ready: false,
            },
          }
        : {}),
    }));
    await mount(request);
    await click("Preview application");
    expect(button("Apply version").disabled).toBe(false);
    await act(async () =>
      (host.querySelectorAll('input[type="radio"]')[1] as HTMLInputElement).click(),
    );
    expect(host.textContent).not.toContain("Apply version");
    await click("Preview application");
    await click("Apply version");
    expect(request.mock.calls.at(-1)?.[0].apply).toEqual({
      scope: "user",
      agents: ["codex"],
      instanceIds: ["codex"],
      expectedHash: "preview-user",
    });
    expect(host.textContent).toContain("Installed; start a new session to load.");
    expect(host.textContent).not.toContain("Ready for the next message.");
  });
  it("allows confirmed archival of an unresolved publication without resubmission", async () => {
    const draft = {
      ...fixtureDraft,
      publication: {
        state: "unknown" as const,
        contentHash: "hash",
        version: "1.0.0",
        skillId: "fixture/skills/review-code",
        skillPath: "skills/1.0.0/review-code/SKILL.md",
        repository: "fixture/skills",
        visibility: "private" as const,
      },
    };
    const request = vi.fn(async (input: AuthoringRequest) => ({
      draft: input.operation === "new" ? null : draft,
    }));
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount(request);
    await click("Start new skill");
    expect(confirmation).toHaveBeenCalled();
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["read", "new"]);
    expect(host.textContent).toContain("What should this skill do?");
    confirmation.mockRestore();
  });
});

describe("selected-copy authoring", () => {
  const seed = {
    key: "copy:hash",
    label: "selected-skill",
    content: { ...fixtureDraft, name: "selected-skill", version: "2.0.0" },
  };
  it("keeps an existing draft until archive confirmation", async () => {
    const request = vi.fn(async (input: AuthoringRequest) => ({
      draft: input.operation === "new" ? null : fixtureDraft,
    }));
    await mount(request, vi.fn(), seed);
    expect(host.textContent).toContain("Your saved draft is still here");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["read"]);
    vi.mocked(window.confirm).mockReturnValue(false);
    await click("Use selected copy");
    expect(request).toHaveBeenCalledTimes(1);
    vi.mocked(window.confirm).mockReturnValue(true);
    await click("Use selected copy");
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["read", "new"]);
    expect(host.textContent).toContain("Bump patch to 2.0.1");
  });
  it("seeds and bumps a copy without automatic writes", async () => {
    const request = vi.fn(async () => ({ draft: null }));
    await mount(request, vi.fn(), seed);
    expect(request).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("Bump patch to 2.0.1");
    await click("Bump patch to 2.0.1");
    expect(host.textContent).toContain("Bump patch to 2.0.2");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("custom frontmatter resume", () => {
  it("keeps custom metadata through resume, version bump and save", async () => {
    const sourceFrontmatter =
      "name: review-code\ndescription: Review changes\nallowed-tools: [Read, Bash]\nmetadata:\n  version: 1.0.0\n  custom:\n    owner: example";
    const request = vi.fn(async (input: AuthoringRequest) => ({
      draft: { ...fixtureDraft, sourceFrontmatter, ...input.draft },
    }));
    await mount(request);
    expect(host.textContent).toContain("owner: example");
    await click("Bump patch to 1.0.1");
    await click("Close");
    expect(request.mock.calls[1]?.[0].draft).toMatchObject({ sourceFrontmatter, version: "1.0.1" });
    expect(skillMarkdown(request.mock.calls[1]![0].draft!)).toContain("allowed-tools:");
    expect(skillMarkdown(request.mock.calls[1]![0].draft!)).toContain("owner: example");
  });
});
