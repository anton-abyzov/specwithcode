import type {
  ProjectSkillCopy,
  ProjectSkillCopiesInput,
  ProjectSkillCopiesResult,
  ProjectSkillRow,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useSkillControls } from "../settings/ProjectSkillControls";
import { skillActionErrorText } from "../settings/ProjectSkillActions.logic";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { SkillDetailMarkdown } from "./SkillDetailMarkdown";
import { SkillCopyCompare } from "./SkillCopyCompare";
import { skillBody, skillDescriptionParts } from "./SkillDetail.logic";
import { SkillAvailability } from "./SkillAvailability";

export function SkillDetailPanel({
  row,
  machineLabel,
  initialView = "overview",
  onEdit,
  onChanged,
  editError,
  children,
}: {
  row: ProjectSkillRow;
  machineLabel: string;
  initialView?: "overview" | "compare";
  editError?: string | null;
  onEdit: (copy: ProjectSkillCopy) => void;
  onChanged: () => void;
  children: ReactNode;
}) {
  const controls = useSkillControls();
  const command = useAtomCommand(projectWorkspace.skillCopies, { reportFailure: false });
  const [view, setView] = useState<"overview" | "compare" | "instructions">(initialView);
  const [expanded, setExpanded] = useState(false);
  const [copies, setCopies] = useState<ReadonlyArray<ProjectSkillCopy>>([]);
  const [preview, setPreview] = useState<ProjectSkillCopiesResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [instructionId, setInstructionId] = useState("");
  const generation = useRef(0);
  const parts = skillDescriptionParts(row.description);
  const contextKey = controls
    ? `${controls.environmentId}:${controls.projectId}:${controls.cwd ?? ""}:${controls.threadId ?? ""}:${controls.userLevel}:${row.name}`
    : row.name;
  const latest = useRef({ controls, command });
  latest.current = { controls, command };
  async function request(
    operation: ProjectSkillCopiesInput["operation"],
    extra: Partial<ProjectSkillCopiesInput> = {},
  ) {
    const active = latest.current;
    if (!active.controls) return;
    const token = ++generation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await active.command({
        environmentId: active.controls.environmentId,
        input: {
          projectId: active.controls.projectId,
          skill: row.name,
          ...(active.controls.cwd ? { cwd: active.controls.cwd } : {}),
          ...(active.controls.threadId ? { threadId: active.controls.threadId } : {}),
          userLevel: active.controls.userLevel,
          operation,
          ...extra,
        },
      });
      if (token !== generation.current) return;
      if (result._tag !== "Success") {
        setPreview(null);
        setError(skillActionErrorText(squashAtomCommandFailure(result)));
        return;
      }
      setCopies(result.value.copies);
      setPreview(operation === "preview" ? result.value : null);
      if (operation === "apply") {
        setNotice("Copies updated. Agent readiness still depends on its next discovery.");
        onChanged();
      }
    } catch (e) {
      if (token === generation.current) {
        setPreview(null);
        setError(e instanceof Error ? e.message : "Skill copies could not be read.");
      }
    } finally {
      if (token === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    setCopies([]);
    setPreview(null);
    setInstructionId("");
    void request("read");
    return () => {
      generation.current++;
    };
  }, [contextKey]);
  const selected = copies.find((c) => c.id === instructionId) ?? copies[0];
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 text-sm"
      data-testid="skill-detail-panel"
    >
      <div className="space-y-4 pb-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{row.lock?.skillId ? "Registry skill" : "Local copy"}</Badge>
          <span className="text-xs text-muted-foreground">{machineLabel}</span>
          {row.divergent ? (
            <button
              type="button"
              onClick={() => setView("compare")}
              className="rounded-sm text-sm text-warning-foreground underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring"
            >
              Copies differ
            </button>
          ) : null}
        </div>
        {parts.summary ? (
          <SkillDetailMarkdown text={parts.summary} />
        ) : (
          <p className="text-muted-foreground">No description provided.</p>
        )}
        <section className="space-y-1" aria-label="When to use">
          <h3 className="font-medium">When to use</h3>
          {parts.usage ? (
            <SkillDetailMarkdown text={parts.usage} />
          ) : (
            <p className="text-muted-foreground">
              No usage guidance provided. Edit the skill to add it.
            </p>
          )}
        </section>
        {parts.more ? (
          <>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
            >
              {expanded ? "Show less" : "Show more"}
            </Button>
            {expanded ? <SkillDetailMarkdown text={parts.full} /> : null}
          </>
        ) : null}
        <SkillAvailability />
      </div>
      <div
        className="mb-5 flex flex-wrap items-center gap-1 border-b pb-2"
        aria-label="Skill detail views"
      >
        {(["overview", "compare", "instructions"] as const).map((id) => (
          <Button
            key={id}
            aria-pressed={view === id}
            size="sm"
            variant={view === id ? "secondary" : "ghost"}
            onClick={() => setView(id)}
          >
            {id === "overview" ? "Overview" : id === "compare" ? "Compare" : "Instructions"}
          </Button>
        ))}
      </div>
      {editError ? (
        <p role="alert" className="mb-4 text-destructive-foreground">
          {editError}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mb-4 space-y-2 text-destructive-foreground">
          <p>{error}</p>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void request("read")}>
            Retry reading copies
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mb-4">
          {notice}
        </p>
      ) : null}
      {view === "overview" ? children : null}
      {view !== "overview" && busy && copies.length === 0 ? (
        <p className="flex gap-2 text-muted-foreground">
          <Spinner className="size-4" />
          Reading copies…
        </p>
      ) : null}
      {view !== "overview" && !busy && !error && copies.length === 0 ? (
        <p className="text-muted-foreground">
          No readable copies are available in this scope. Refresh the skill inventory or check file
          access.
        </p>
      ) : null}
      {view === "compare" && copies.length > 0 ? (
        <SkillCopyCompare
          copies={copies}
          machineLabel={machineLabel}
          busy={busy}
          canWrite={controls?.canWrite ?? false}
          preview={preview}
          onCancel={() => setPreview(null)}
          onPreview={(sourceId, targetIds) => void request("preview", { sourceId, targetIds })}
          onApply={() => {
            if (preview?.expected && preview.sourceId && preview.targetIds)
              void request("apply", {
                sourceId: preview.sourceId,
                targetIds: preview.targetIds,
                expected: preview.expected,
              });
          }}
        />
      ) : null}
      {view === "instructions" && selected ? (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="min-w-0 text-xs text-muted-foreground">
              Copy
              <select
                aria-label="Instruction copy"
                className="mt-1 block max-w-full rounded-md border bg-background p-2 text-sm text-foreground"
                value={selected.id}
                onChange={(e) => setInstructionId(e.target.value)}
              >
                {copies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.agents.map((a) => a.label).join(", ")} · {c.version ?? "Unversioned"}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !selected.writable || !controls?.canWrite}
              title={selected.reason}
              onClick={() => onEdit(selected)}
            >
              Edit and publish
            </Button>
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">{selected.path}</p>
          {!selected.writable ? (
            <p className="text-xs text-muted-foreground">
              {selected.reason ?? "This copy is managed by its provider."}
            </p>
          ) : null}
          <SkillDetailMarkdown text={skillBody(selected.content)} />
        </section>
      ) : null}
    </div>
  );
}
