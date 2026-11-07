import { useState } from "react";
import { createRoot } from "react-dom/client";
import { RegistryProvider } from "@effect/atom-react";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type SkillAuthoringDraft,
  type SkillAuthoringResult,
} from "@specweave-studio/contracts";
import {
  SkillAuthoringForm,
  type AuthoringRequest,
} from "../../src/components/skills/SkillAuthoringSheet";
import type { ProviderInstanceEntry } from "../../src/providerInstances";
import "./fixture.css";
const search = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", search.get("theme") === "dark");
const agent: ProviderInstanceEntry = {
  instanceId: ProviderInstanceId.make("codex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Fixture Codex",
  enabled: true,
  installed: true,
  status: "ready",
  isDefault: true,
  isAvailable: true,
  models: [
    {
      slug: "fixture-model",
      name: "Fixture model",
      isCustom: false,
      capabilities: null,
      billing: "subscription",
    },
  ],
  snapshot: {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Fixture Codex",
    enabled: true,
    installed: true,
    status: "ready",
    version: "fixture",
    checkedAt: "2026-11-04T00:00:00Z",
    auth: { status: "authenticated", email: "fixture@example.invalid" },
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate: false, canInstall: false },
  },
};
let draft: SkillAuthoringDraft | null =
  search.get("state") === "new"
    ? null
    : {
        id: "12345678-1234-1234-1234-123456789abc",
        revision: 1,
        updatedAt: "2026-11-04T00:00:00Z",
        name: "review-pull-request",
        description: "Use when reviewing a pull request for correctness and missing tests.",
        instructions:
          "Read the changed code and relevant tests.\n\nFor each verified issue, provide its severity, file and line, reproduction scenario, and smallest fix.\n\nKeep findings separate from assumptions. Do not modify files.",
        version: "1.0.0",
        prompt: "Review pull requests with evidence and concise findings.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" },
      };
if (draft && ["queued", "published", "rejected"].includes(search.get("state") ?? ""))
  draft = {
    ...draft,
    publication: {
      state: search.get("state") as "queued" | "published" | "rejected",
      contentHash: "fixture-content-hash",
      version: "1.0.0",
      skillId: "fixture/skills/review-pull-request",
      skillPath: "skills/review-pull-request/SKILL.md",
      repository: "fixture/skills",
      visibility: "private",
      submissionId: "fixture-submission",
      tenant: "fixture-workspace",
      ...(search.get("state") === "rejected"
        ? { detail: "Add a concrete example before submitting again." }
        : {}),
    },
  };
async function request(input: AuthoringRequest): Promise<SkillAuthoringResult> {
  if (input.operation === "save" || input.operation === "generate")
    draft = {
      ...input.draft!,
      ...(input.operation === "generate"
        ? {
            name: "review-pull-request",
            description: "Review pull requests",
            instructions: "Read changed files and cite verified findings.",
          }
        : {}),
      id: draft?.id ?? "12345678-1234-1234-1234-123456789abc",
      revision: (draft?.revision ?? 0) + 1,
      updatedAt: "2026-11-04T00:00:00Z",
    };
  if (input.operation === "publish" && draft)
    draft = {
      ...draft,
      revision: draft.revision + 1,
      publication: {
        ...input.publication!,
        state: "queued",
        contentHash: "fixture-content-hash",
        version: draft.version,
        skillId: `fixture/skills/${draft.name}`,
        skillPath: `skills/${draft.name}/SKILL.md`,
        submissionId: "fixture-submission",
      },
    };
  if (input.operation === "previewApply" || input.operation === "apply")
    return {
      draft,
      applyResult: {
        preview: input.operation === "previewApply",
        expectedHash: "fixture-preview-hash",
        files: [
          `${input.apply?.scope === "user" ? "/fixture/home" : "/fixture/project"}/.agents/skills/review-pull-request/SKILL.md`,
        ],
        summary: "Install the reviewed version 1.0.0.",
        ...(input.operation === "apply" ? { installedVersion: "1.0.0" } : {}),
        ready: false,
      },
    };
  return { draft };
}
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <main className="p-6">
      <button onClick={() => setOpen(true)}>Create skill</button>
      <SkillAuthoringForm
        open={open}
        onOpenChange={setOpen}
        machineLabel="Fixture Mac"
        cwd="/fixture/project"
        initialInstanceId="codex"
        agents={[agent]}
        request={request}
        canWrite
        canGenerate
        canPublish
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <RegistryProvider>
    <Fixture />
  </RegistryProvider>,
);
