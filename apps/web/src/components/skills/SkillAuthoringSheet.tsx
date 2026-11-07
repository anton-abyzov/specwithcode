import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  ProviderInstanceId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type SkillAuthoringContent,
  type SkillAuthoringDraft,
  type SkillAuthoringInput,
  type SkillAuthoringResult,
  type SkillApplyResult,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { accountEmailLine } from "../../studio/modelAvailability";
import { useProviderEntries } from "../studio/shell/ModelBadge";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Sheet, SheetHeader, SheetTitle, SheetDescription, SheetPopup } from "../ui/sheet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SkillPublicationStatus } from "./SkillPublicationStatus";
import { SkillApplyPanel } from "./SkillApplyPanel";
import {
  nextSkillPatchVersion,
  skillAuthoringSeedFromMarkdown,
  skillAuthoringMarkdown,
  type SkillAuthoringSeed,
} from "./skillAuthoringSeed";

export interface SkillAuthoringSheetProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd?: string | undefined;
  threadId?: ThreadId | undefined;
  userLevel?: boolean | undefined;
  machineLabel: string;
  initialInstanceId?: string | undefined;
  seed?: SkillAuthoringSeed | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
export type AuthoringRequest = Omit<
  SkillAuthoringInput,
  "projectId" | "cwd" | "threadId" | "userLevel"
>;
const blank: SkillAuthoringContent = {
  name: "",
  description: "",
  instructions: "",
  version: "1.0.0",
  prompt: "",
};

export const skillMarkdown = skillAuthoringMarkdown;

export function SkillAuthoringSheet(props: SkillAuthoringSheetProps) {
  const [hasOpened, setHasOpened] = useState(props.open);
  useEffect(() => {
    if (props.open) setHasOpened(true);
  }, [props.open]);
  return props.open || hasOpened ? <ConnectedSkillAuthoringSheet {...props} /> : null;
}

function ConnectedSkillAuthoringSheet(props: SkillAuthoringSheetProps) {
  const command = useAtomCommand(projectWorkspace.skillAuthoring, { reportFailure: false });
  const entries = useProviderEntries(props.environmentId);
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const canGenerate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canSource = useEnvironmentScope(props.environmentId, AuthSourceControlWriteScope);
  const canRun = useEnvironmentScope(props.environmentId, AuthTerminalOperateScope);
  const request = useCallback(
    async (input: AuthoringRequest) => {
      const result = await command({
        environmentId: props.environmentId,
        input: {
          projectId: props.projectId,
          ...(props.cwd ? { cwd: props.cwd } : {}),
          ...(props.threadId ? { threadId: props.threadId } : {}),
          ...(props.userLevel ? { userLevel: true } : {}),
          ...input,
        },
      });
      if (result._tag === "Success") return result.value;
      const failure = squashAtomCommandFailure(result);
      throw failure instanceof Error
        ? failure
        : new Error("The machine did not confirm this action. Your draft is still here.");
    },
    [command, props.environmentId, props.projectId, props.cwd, props.threadId, props.userLevel],
  );
  return (
    <SkillAuthoringForm
      key={`${props.environmentId}:${props.projectId}:${props.cwd ?? ""}:${props.userLevel ?? false}`}
      {...props}
      agents={[...entries.values()]}
      request={request}
      canWrite={canWrite}
      canGenerate={canWrite && canGenerate}
      canPublish={canWrite && canRun && canSource}
      canApply={canWrite && canRun}
    />
  );
}

export function SkillAuthoringForm({
  open,
  onOpenChange,
  agents,
  request,
  canWrite,
  canGenerate,
  canPublish,
  machineLabel,
  cwd,
  initialInstanceId,
  seed,
  userLevel = false,
  canApply = canPublish,
}: Pick<
  SkillAuthoringSheetProps,
  "open" | "onOpenChange" | "machineLabel" | "cwd" | "initialInstanceId" | "userLevel" | "seed"
> & {
  agents: readonly ProviderInstanceEntry[];
  request: (input: AuthoringRequest) => Promise<SkillAuthoringResult>;
  canWrite: boolean;
  canGenerate: boolean;
  canPublish: boolean;
  canApply?: boolean;
}) {
  const [acceptedSeed, setAcceptedSeed] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [pasteMode, setPasteMode] = useState(false);
  const [content, setContent] = useState<SkillAuthoringContent>(blank);
  const [draft, setDraft] = useState<SkillAuthoringDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [step, setStep] = useState<"describe" | "review" | "apply">("describe");
  const [repository, setRepository] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [tenant, setTenant] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [applyUser, setApplyUser] = useState(userLevel);
  const [selectedAgents, setSelectedAgents] = useState<string[]>(
    initialInstanceId ? [initialInstanceId] : [],
  );
  const [application, setApplication] = useState<SkillApplyResult | null>(null);
  const readyAgents = agents.filter(
    (agent) => agent.enabled && agent.installed && agent.isAvailable,
  );
  const applyAgents = readyAgents.filter(
    (agent) => agent.isDefault && ["codex", "claudeAgent", "cursor"].includes(agent.driverKind),
  );
  const applySelection = selectedAgents.filter((id) =>
    applyAgents.some((agent) => agent.instanceId === id),
  );
  const selectedProvider = agents.find(
    (agent) => agent.instanceId === content.modelSelection?.instanceId,
  );
  const selectedModel = selectedProvider?.models.find(
    (model) => model.slug === content.modelSelection?.model,
  );
  const modelOptions = useMemo(
    () => new Map(agents.map((agent) => [agent.instanceId, agent.models])),
    [agents],
  );
  const publication = draft?.publication;
  const frozen =
    publication !== undefined &&
    ["submitting", "unknown", "queued", "reviewing"].includes(publication.state);
  const valid =
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(content.name) &&
    Boolean(content.description.trim()) &&
    Boolean(content.instructions.trim()) &&
    /^\d+\.\d+\.\d+$/.test(content.version);
  const sync = (result: SkillAuthoringResult) => {
    setDraft(result.draft);
    if (result.draft) {
      const {
        name,
        description,
        instructions,
        version,
        prompt,
        modelSelection,
        sourceFrontmatter,
      } = result.draft;
      setContent({
        name,
        description,
        instructions,
        version,
        prompt,
        ...(modelSelection ? { modelSelection } : {}),
        ...(sourceFrontmatter !== undefined ? { sourceFrontmatter } : {}),
      });
      setDirty(false);
      if (result.draft.publication) {
        setRepository(result.draft.publication.repository);
        setVisibility(result.draft.publication.visibility);
        setTenant(result.draft.publication.tenant ?? "");
      }
    }
    if (!result.draft) {
      setContent(blank);
      setDirty(false);
      setApplication(null);
      setStep("describe");
    }
    if (result.applyResult) setApplication(result.applyResult);
  };
  useEffect(() => {
    if (!open || loaded || busyRef.current) return;
    busyRef.current = true;
    setBusy("read");
    void request({ operation: "read" })
      .then((result) => {
        sync(result);
        setLoaded(true);
        if (result.draft)
          setStep(result.draft.publication?.state === "published" ? "apply" : "review");
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        busyRef.current = false;
        setBusy(null);
      });
  }, [open, loaded, request]);

  useEffect(() => {
    // An Edit click may prepare a new draft, but never overwrites a saved one.
    if (!open || !loaded || draft || dirty || !seed || acceptedSeed === seed.key) return;
    setContent(seed.content);
    setDirty(true);
    setStep("review");
    setAcceptedSeed(seed.key);
  }, [open, loaded, draft, dirty, seed, acceptedSeed]);

  const edit = (patch: Partial<SkillAuthoringContent>) => {
    setContent((current) => ({ ...current, ...patch }));
    setDirty(true);
    setConfirmed(false);
    setApplication(null);
    setNotice(null);
  };
  const execute = async (
    operation: AuthoringRequest["operation"],
    extra: Partial<AuthoringRequest> = {},
  ) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(operation);
    setError(null);
    setNotice(null);
    try {
      const result = await request({
        operation,
        ...(draft ? { draftId: draft.id, revision: draft.revision } : {}),
        ...(["save", "generate"].includes(operation) ? { draft: content } : {}),
        ...extra,
      });
      sync(result);
      if (operation === "save") setNotice("Draft saved on this machine.");
      if (operation === "generate") setStep("review");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (operation === "apply" || operation === "previewApply") setApplication(null);
      // Generation persists the prompt before running. Refresh only the revision, keeping all edits.
      if (operation !== "read") {
        try {
          const current = await request({ operation: "read" });
          setDraft(current.draft);
        } catch {
          /* Keep the original failure. */
        }
      }
      return null;
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };
  const importSeed = async () => {
    if (!seed || frozen || busyRef.current) return;
    if (
      draft &&
      !window.confirm(
        "Archive the current draft and its publication receipt before editing this copy? Unsaved edits will be discarded.",
      )
    )
      return;
    if (draft && !(await execute("new"))) return;
    setContent(seed.content);
    setDirty(true);
    setStep("review");
    setAcceptedSeed(seed.key);
    setConfirmed(false);
    setApplication(null);
  };
  const importPaste = () => {
    const parsed = skillAuthoringSeedFromMarkdown(paste, content.name);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    if (
      (content.instructions || content.name) &&
      !window.confirm("Replace the current draft fields with this pasted skill?")
    )
      return;
    edit(parsed.content);
    setError(null);
    setStep("review");
  };
  const close = async () => {
    if (busyRef.current) {
      onOpenChange(false);
      return;
    }
    if (dirty && !(await execute("save"))) return;
    onOpenChange(false);
  };
  const publish = async () => {
    // Save first, then use that response's revision instead of the render's stale revision.
    let current = draft;
    if (dirty || !current) {
      const result = await execute("save");
      if (!result?.draft) return;
      current = result.draft;
    }
    await execute("publish", {
      draftId: current.id,
      revision: current.revision,
      publication: {
        repository: repository.trim(),
        visibility,
        ...(visibility === "private" && tenant.trim() ? { tenant: tenant.trim() } : {}),
      },
    });
  };
  const apply = (preview: boolean) => {
    const cliAgents = applySelection.flatMap((id) => {
      const driver = agents.find((agent) => agent.instanceId === id)?.driverKind;
      const mapped = driver === "claudeAgent" ? "claude-code" : driver;
      return mapped ? [mapped] : [];
    });
    void execute(preview ? "previewApply" : "apply", {
      apply: {
        scope: applyUser ? "user" : "project",
        agents: [...new Set(cliAgents)],
        instanceIds: applySelection.map((id) => ProviderInstanceId.make(id)),
        ...(!preview && application ? { expectedHash: application.expectedHash } : {}),
      },
    });
  };
  const inProgress = busy !== null;
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) void close();
        else onOpenChange(true);
      }}
    >
      <SheetPopup className="w-full sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{seed ? `Edit ${seed.label}` : "New skill"}</SheetTitle>
          <SheetDescription>
            Describe it, review the version, then choose where to apply it.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-6">
          <nav aria-label="Skill creation steps" className="flex flex-wrap gap-2 border-b pb-3">
            {(["describe", "review", "apply"] as const).map((item, index) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={step === item ? "secondary" : "ghost"}
                disabled={item === "apply" && (publication?.state !== "published" || dirty)}
                onClick={() => setStep(item)}
                aria-current={step === item ? "step" : undefined}
              >
                {index + 1}.{" "}
                {item === "describe"
                  ? "Describe"
                  : item === "review"
                    ? "Review & publish"
                    : "Apply"}
              </Button>
            ))}
          </nav>
          {error ? (
            <p role="alert" className="whitespace-pre-wrap text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
          {!canWrite ? (
            <p className="text-sm text-muted-foreground">
              File write permission is required to save a skill.
            </p>
          ) : null}
          {seed && loaded && acceptedSeed !== seed.key && draft ? (
            <section
              className="space-y-2 rounded-lg border bg-muted/40 p-3"
              aria-label="Saved draft"
            >
              <p className="text-sm">
                Your saved draft is still here. Use the selected copy to start an edit of{" "}
                {seed.label}.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={inProgress || frozen || !canWrite}
                onClick={() => void importSeed()}
              >
                Use selected copy
              </Button>
              {frozen ? (
                <p className="text-xs text-muted-foreground">
                  Check the current publication status before replacing this draft.
                </p>
              ) : null}
            </section>
          ) : null}
          {step === "describe" ? (
            <section className="space-y-4">
              <div className="flex gap-2" aria-label="Create a skill from">
                <Button
                  type="button"
                  size="sm"
                  variant={!pasteMode ? "secondary" : "ghost"}
                  onClick={() => setPasteMode(false)}
                >
                  Describe
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={pasteMode ? "secondary" : "ghost"}
                  onClick={() => setPasteMode(true)}
                >
                  Paste SKILL.md
                </Button>
              </div>
              {pasteMode ? (
                <div className="space-y-3">
                  <label className="block space-y-2 text-sm font-medium">
                    Paste a skill
                    <Textarea
                      aria-label="Paste a skill"
                      rows={9}
                      maxLength={110000}
                      value={paste}
                      disabled={inProgress || frozen}
                      onChange={(event) => setPaste(event.target.value)}
                      placeholder="Paste SKILL.md or write your instructions here."
                    />
                  </label>
                  <Button
                    type="button"
                    disabled={inProgress || frozen || !paste.trim()}
                    onClick={importPaste}
                  >
                    Review pasted skill
                  </Button>
                </div>
              ) : (
                <>
                  <label className="block space-y-2 text-sm font-medium">
                    What should this skill do?
                    <Textarea
                      aria-label="What should this skill do?"
                      rows={5}
                      value={content.prompt}
                      maxLength={20000}
                      disabled={inProgress || frozen}
                      onChange={(event) => edit({ prompt: event.target.value })}
                      placeholder="For example: review a pull request and explain each finding with a file and line."
                    />
                  </label>
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Generate with</p>
                    <ProviderModelPicker
                      activeInstanceId={
                        content.modelSelection?.instanceId ??
                        ProviderInstanceId.make(initialInstanceId ?? "studio_no_provider")
                      }
                      model={content.modelSelection?.model ?? ""}
                      instanceEntries={readyAgents}
                      modelOptionsByInstance={modelOptions}
                      lockedProvider={null}
                      isComposerOwned={false}
                      unset={!content.modelSelection}
                      disabled={inProgress || frozen}
                      {...(!content.modelSelection
                        ? { triggerLabel: "Choose provider and model" }
                        : {})}
                      onInstanceModelChange={(instanceId, model) =>
                        edit({ modelSelection: { instanceId, model } })
                      }
                    />
                    {selectedProvider ? (
                      <p className="text-xs text-muted-foreground">
                        {accountEmailLine(
                          selectedProvider.displayName,
                          selectedProvider.snapshot,
                        ) ?? selectedProvider.displayName}
                        . Billing: {selectedModel?.billing ?? "not reported"}.
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      Only this description goes to the selected model. No fallback model is used.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={
                        inProgress ||
                        frozen ||
                        !canGenerate ||
                        !content.prompt.trim() ||
                        !selectedModel ||
                        !selectedProvider?.isAvailable
                      }
                      onClick={() => {
                        if (
                          (content.name || content.description || content.instructions) &&
                          !window.confirm(
                            "Replace the current name, description and instructions with a generated draft?",
                          )
                        )
                          return;
                        void execute("generate");
                      }}
                    >
                      {busy === "generate" ? "Generating draft…" : "Generate draft"}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => setStep("review")}>
                      Write myself
                    </Button>
                  </div>
                </>
              )}
              <fieldset disabled={inProgress} className="space-y-2 rounded-lg border p-3 text-sm">
                <legend className="px-1 font-medium">Use it with</legend>
                <div className="flex flex-wrap gap-3">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={!applyUser}
                      onChange={() => {
                        setApplyUser(false);
                        setApplication(null);
                      }}
                    />
                    This project
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      checked={applyUser}
                      onChange={() => {
                        setApplyUser(true);
                        setApplication(null);
                      }}
                    />
                    My projects on this machine
                  </label>
                </div>
                <div className="flex flex-wrap gap-3">
                  {applyAgents.map((agent) => (
                    <label key={agent.instanceId} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedAgents.includes(agent.instanceId)}
                        onChange={(event) => {
                          setSelectedAgents((ids) =>
                            event.target.checked
                              ? [...ids, agent.instanceId]
                              : ids.filter((id) => id !== agent.instanceId),
                          );
                          setApplication(null);
                        }}
                      />
                      {agent.displayName}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  These choices are reviewed again after publication. Nothing is installed yet.
                </p>
              </fieldset>
            </section>
          ) : null}
          {step === "review" ? (
            <section className="space-y-4">
              <fieldset disabled={inProgress || frozen} className="space-y-4">
                <label className="block space-y-2 text-sm font-medium">
                  Invocation name
                  <Input
                    aria-label="Invocation name"
                    value={content.name}
                    maxLength={100}
                    placeholder="review-pull-request"
                    onChange={(event) => edit({ name: event.target.value })}
                  />
                </label>
                <label className="block space-y-2 text-sm font-medium">
                  When to use
                  <Textarea
                    aria-label="When to use"
                    value={content.description}
                    maxLength={2000}
                    rows={2}
                    onChange={(event) => edit({ description: event.target.value })}
                  />
                </label>
                <label className="block space-y-2 text-sm font-medium">
                  Instructions and examples
                  <Textarea
                    aria-label="Instructions and examples"
                    value={content.instructions}
                    maxLength={100000}
                    rows={9}
                    onChange={(event) => edit({ instructions: event.target.value })}
                  />
                </label>
                <label className="block space-y-2 text-sm font-medium">
                  Version
                  <Input
                    aria-label="Version"
                    value={content.version}
                    maxLength={100}
                    onChange={(event) => edit({ version: event.target.value })}
                  />
                </label>
                {nextSkillPatchVersion(content.version) ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => edit({ version: nextSkillPatchVersion(content.version)! })}
                  >
                    Bump patch to {nextSkillPatchVersion(content.version)}
                  </Button>
                ) : null}
              </fieldset>
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Review exact SKILL.md
                </summary>
                <pre className="mt-3 whitespace-pre-wrap break-all text-xs">
                  {skillMarkdown(content)}
                </pre>
              </details>
              {!valid ? (
                <p className="text-xs text-muted-foreground">
                  Use a lowercase hyphenated name, a description, instructions and a version such as
                  1.0.0.
                </p>
              ) : null}
              {publication && !dirty ? (
                <SkillPublicationStatus
                  publication={{ ...publication, status: publication.state }}
                  busy={inProgress || !canApply}
                  onRefresh={() => void execute("status")}
                />
              ) : null}
              {!frozen && (publication?.state !== "published" || dirty) ? (
                <fieldset disabled={inProgress} className="space-y-3 rounded-lg border p-4">
                  <legend className="px-1 text-sm font-medium">Publication destination</legend>
                  <label className="block space-y-2 text-sm">
                    GitHub repository
                    <Input
                      aria-label="GitHub repository"
                      placeholder="owner/skill-library"
                      value={repository}
                      onChange={(event) => {
                        setRepository(event.target.value);
                        setConfirmed(false);
                      }}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    The machine's connected publishing account must have access to this repository.
                  </p>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="radio"
                      checked={visibility === "private"}
                      onChange={() => {
                        setVisibility("private");
                        setConfirmed(false);
                      }}
                    />
                    Private
                  </label>
                  <label className="flex gap-2 text-sm">
                    <input
                      type="radio"
                      checked={visibility === "public"}
                      onChange={() => {
                        setVisibility("public");
                        setConfirmed(false);
                      }}
                    />
                    Public, anyone can read this skill
                  </label>
                  {visibility === "private" ? (
                    <label className="block space-y-2 text-sm">
                      Private workspace
                      <Input
                        aria-label="Private workspace"
                        value={tenant}
                        onChange={(event) => {
                          setTenant(event.target.value);
                          setConfirmed(false);
                        }}
                        placeholder="Workspace slug"
                      />
                    </label>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Private publishing requires workspace access. It will never switch to public
                    automatically.
                  </p>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={confirmed}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    <span>
                      I reviewed the exact file above and want to send it to this repository and the
                      review queue as a {visibility} skill.
                    </span>
                  </label>
                  <Button
                    type="button"
                    disabled={
                      !canPublish ||
                      !valid ||
                      !confirmed ||
                      !/^[\w.-]+\/[\w.-]+$/.test(repository.trim()) ||
                      (visibility === "private" && !tenant.trim())
                    }
                    onClick={() => void publish()}
                  >
                    Publish for review
                  </Button>
                </fieldset>
              ) : null}
              {publication?.state === "published" && !dirty ? (
                <Button type="button" onClick={() => setStep("apply")}>
                  Choose where to apply
                </Button>
              ) : null}
            </section>
          ) : null}
          {step === "apply" && publication?.state === "published" && !dirty ? (
            <SkillApplyPanel
              userLevel={applyUser}
              onScope={(value) => {
                setApplyUser(value);
                setApplication(null);
              }}
              instanceIds={applySelection}
              onAgents={(value) => {
                setSelectedAgents(value);
                setApplication(null);
              }}
              agents={applyAgents}
              machineLabel={machineLabel}
              folder={cwd ?? "Project workspace"}
              busy={inProgress || !canApply}
              preview={
                application?.preview
                  ? `${publication.skillId}@${publication.version}\n${application.summary}\n${application.files.join("\n")}`
                  : null
              }
              result={
                application && !application.preview
                  ? `${application.summary}\n${application.ready ? "Ready for the next message." : "Installed; start a new session to load. Active sessions were not restarted."}`
                  : null
              }
              onPreview={() => apply(true)}
              onApply={() => apply(false)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button
              type="button"
              variant="outline"
              disabled={inProgress || !canWrite || !dirty || frozen}
              onClick={() => void execute("save")}
            >
              Save draft
            </Button>
            <Button type="button" variant="ghost" onClick={() => void close()}>
              Close
            </Button>
            {draft && !["queued", "reviewing"].includes(publication?.state ?? "") ? (
              <Button
                type="button"
                variant="ghost"
                disabled={inProgress || !canWrite}
                onClick={() => {
                  if (
                    window.confirm(
                      "Archive this draft and start a new skill? Its publication may still complete. The receipt will be kept in history and the same version cannot be submitted again. Unsaved edits will be discarded.",
                    )
                  )
                    void execute("new");
                }}
              >
                Start new skill
              </Button>
            ) : null}
            {notice ? (
              <span role="status" className="text-xs text-muted-foreground">
                {notice}
              </span>
            ) : null}
            {busy ? (
              <span role="status" className="text-xs text-muted-foreground">
                {busy === "read" ? "Loading draft…" : "Working…"}
              </span>
            ) : null}
          </div>
        </div>
      </SheetPopup>
    </Sheet>
  );
}
