/**
 * The "New design system" flows. Each one ends in a proposal the user
 * reviews; nothing here writes a system.
 */
import type {
  DesignOwnerInput,
  DesignSystemProposeInput,
  DesignSystemTokensFile,
  FigmaDesktopStatus,
  ProjectId,
} from "@specweave-studio/contracts";
import { FileJsonIcon, RefreshCwIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  formatBytes,
  ownerFromKey,
  ownerKey,
  PLAYGROUND_KEY,
  readTokensFiles,
  type OwnerProject,
} from "./reviewModel";
import { ScanFromCode, type ScanOutcome } from "./ScanFromCode";

export type NewSystemMode = "code" | "tokens-file" | "figma" | "describe";

export const NEW_SYSTEM_MODES: ReadonlyArray<{ mode: NewSystemMode; label: string }> = [
  { mode: "code", label: "From this project's code" },
  { mode: "tokens-file", label: "From a tokens file" },
  { mode: "figma", label: "From Figma desktop" },
  { mode: "describe", label: "Describe it" },
];

export const FIGMA_OFF_INSTRUCTIONS =
  "In Figma, open Preferences and turn on Enable desktop MCP server.";

export interface FigmaStatusView {
  readonly status: FigmaDesktopStatus | null;
  readonly error: string | null;
  readonly checking: boolean;
  readonly onCheck: () => void;
}

function OwnerSelect({
  id,
  projects,
  value,
  onChange,
}: {
  id: string;
  projects: readonly OwnerProject[];
  value: DesignOwnerInput;
  onChange: (owner: DesignOwnerInput) => void;
}) {
  const key = ownerKey(value);
  const project = value.kind === "project" ? projects.find((p) => p.id === value.projectId) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Save in</Label>
      <Select value={key} onValueChange={(next) => onChange(ownerFromKey(next ?? PLAYGROUND_KEY))}>
        <SelectTrigger id={id} size="sm">
          <SelectValue>{project?.title ?? "Playground"}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={PLAYGROUND_KEY}>Playground</SelectItem>
          {projects.map((candidate) => (
            <SelectItem key={candidate.id} value={`p:${candidate.id}`}>
              {candidate.title}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function NameInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Name (optional)</Label>
      <Input
        id={id}
        size="sm"
        value={value}
        maxLength={180}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-sm text-destructive-foreground">
      {children}
    </p>
  );
}

function TokensFilePanel({
  projects,
  defaultOwner,
  onPropose,
}: {
  projects: readonly OwnerProject[];
  defaultOwner: DesignOwnerInput;
  onPropose: (input: DesignSystemProposeInput) => Promise<string | null>;
}) {
  const id = useId();
  const [owner, setOwner] = useState<DesignOwnerInput>(defaultOwner);
  const [name, setName] = useState("");
  const [files, setFiles] = useState<DesignSystemTokensFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="tokens-file-panel">
      <p className="text-sm text-muted-foreground">
        Pick W3C design tokens (DTCG) JSON, a Figma variables export, or Tokens Studio JSON. Files
        named like <code className="font-mono text-xs">Brand.Light.tokens.json</code> and{" "}
        <code className="font-mono text-xs">Brand.Dark.tokens.json</code> become the Light and Dark
        modes of one system.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <OwnerSelect id={`${id}-owner`} projects={projects} value={owner} onChange={setOwner} />
        <NameInput
          id={`${id}-name`}
          value={name}
          placeholder="Named from the file when empty"
          onChange={setName}
        />
      </div>
      <div className="flex flex-col items-start gap-1.5">
        <Label htmlFor={`${id}-files`}>Tokens files</Label>
        <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
          <FileJsonIcon aria-hidden />
          {files.length === 0 ? "Choose .json files" : "Choose other files"}
        </Button>
        <input
          ref={fileInput}
          id={`${id}-files`}
          data-testid="tokens-file-input"
          type="file"
          accept=".json,application/json"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const picked = [...(event.target.files ?? [])];
            setError(null);
            void readTokensFiles(picked).then((read) => {
              if (read.ok) setFiles(read.files);
              else {
                setFiles([]);
                setError(read.message);
              }
            });
          }}
        />
      </div>
      {files.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs" data-testid="tokens-file-list">
          {files.map((file) => (
            <li key={file.fileName} className="flex items-center gap-2">
              <FileJsonIcon aria-hidden className="size-3.5 text-muted-foreground" />
              <code className="font-mono">{file.fileName}</code>
              <span className="text-muted-foreground">
                {formatBytes(new Blob([file.contents]).size)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <Problem>{error}</Problem>
      <div className="flex justify-end">
        <Button
          data-testid="tokens-file-propose"
          disabled={busy || files.length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            const trimmed = name.trim();
            void onPropose({
              owner,
              from: { kind: "tokens-file", files, ...(trimmed ? { name: trimmed } : {}) },
            }).then((problem) => {
              setBusy(false);
              setError(problem);
            });
          }}
        >
          {busy ? "Reading tokens…" : "Propose"}
        </Button>
      </div>
    </div>
  );
}

/** The tools Figma's desktop server lists; variables are read only through one of them. */
function FigmaTools({
  tools,
  variablesTool,
}: {
  tools: FigmaDesktopStatus["tools"];
  variablesTool: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="figma-tools">
      <p className="text-xs font-medium text-foreground">
        {tools.length === 1 ? "1 tool listed" : `${tools.length} tools listed`}
      </p>
      {tools.length === 0 ? null : (
        <ul className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
          {tools.map((tool) => (
            <li
              key={tool.name}
              className="flex items-baseline gap-2 text-xs"
              title={tool.description}
            >
              <code className="font-mono text-foreground">{tool.name}</code>
              {tool.name === variablesTool ? (
                <span className="text-muted-foreground">reads variables</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FigmaPanel({
  projects,
  defaultOwner,
  figma,
  onPropose,
  onUseFile,
}: {
  projects: readonly OwnerProject[];
  defaultOwner: DesignOwnerInput;
  figma: FigmaStatusView;
  onPropose: (input: DesignSystemProposeInput) => Promise<string | null>;
  onUseFile: () => void;
}) {
  const id = useId();
  const [owner, setOwner] = useState<DesignOwnerInput>(defaultOwner);
  const [name, setName] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = figma.status;

  const checkAgain = (
    <Button variant="outline" size="sm" disabled={figma.checking} onClick={figma.onCheck}>
      <RefreshCwIcon aria-hidden />
      {figma.checking ? "Checking…" : "Check again"}
    </Button>
  );
  const useFile = (
    <Button variant="outline" size="sm" onClick={onUseFile} data-testid="figma-use-file">
      <FileJsonIcon aria-hidden />
      Import an exported variables file instead
    </Button>
  );

  if (status === null)
    return (
      <div className="flex flex-col gap-3" data-testid="figma-panel" data-state="checking">
        <p className="text-sm text-muted-foreground">
          {figma.error ?? "Checking for Figma's desktop server…"}
        </p>
        {figma.error ? (
          <div className="flex flex-wrap gap-2">
            {checkAgain}
            {useFile}
          </div>
        ) : null}
      </div>
    );

  if (status.state !== "connected")
    return (
      <div className="flex flex-col gap-3" data-testid="figma-panel" data-state={status.state}>
        <p className="text-sm text-foreground" data-testid="figma-off">
          {status.state === "off"
            ? `The app cannot reach Figma's desktop server. ${FIGMA_OFF_INSTRUCTIONS} Keep the Figma desktop app open with your file, then check again.`
            : `Figma's desktop server answered with an error. ${status.detail ?? ""}`.trim()}
        </p>
        <p className="text-xs text-muted-foreground">
          Or, in Figma, export your variables as JSON and import that file here.
        </p>
        <div className="flex flex-wrap gap-2">
          {checkAgain}
          {useFile}
        </div>
      </div>
    );

  if (status.variablesTool === null)
    return (
      <div className="flex flex-col gap-3" data-testid="figma-panel" data-state="no-tool">
        <p className="text-sm text-foreground">
          Figma{status.serverName ? ` (${status.serverName})` : ""} is connected, but its server
          lists no tool that reads variables. Update the Figma desktop app, or import an exported
          variables file.
        </p>
        <FigmaTools tools={status.tools} variablesTool={null} />
        <div className="flex flex-wrap gap-2">
          {checkAgain}
          {useFile}
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="figma-panel" data-state="connected">
      <p className="text-sm text-muted-foreground">
        Connected to {status.serverName ?? "Figma"} at{" "}
        <code className="font-mono text-xs">{status.endpoint}</code>. Select a frame or page in
        Figma, then read its variables.
      </p>
      <FigmaTools tools={status.tools} variablesTool={status.variablesTool} />
      <div className="grid gap-3 sm:grid-cols-2">
        <OwnerSelect id={`${id}-owner`} projects={projects} value={owner} onChange={setOwner} />
        <NameInput
          id={`${id}-name`}
          value={name}
          placeholder="Named from Figma when empty"
          onChange={setName}
        />
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor={`${id}-node`}>Node id (optional)</Label>
          <Input
            id={`${id}-node`}
            size="sm"
            value={nodeId}
            maxLength={120}
            placeholder="Uses the current selection in Figma when empty"
            onChange={(event) => setNodeId(event.target.value)}
          />
        </div>
      </div>
      <Problem>{error}</Problem>
      <div className="flex justify-end">
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            const trimmedName = name.trim();
            const trimmedNode = nodeId.trim();
            void onPropose({
              owner,
              from: {
                kind: "figma-desktop",
                ...(trimmedNode ? { nodeId: trimmedNode } : {}),
                ...(trimmedName ? { name: trimmedName } : {}),
              },
            }).then((problem) => {
              setBusy(false);
              setError(problem);
            });
          }}
        >
          {busy ? "Reading variables…" : "Read variables"}
        </Button>
      </div>
    </div>
  );
}

function DescribePanel() {
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="describe-panel">
      <p className="text-foreground">
        Ask an agent in any thread to propose a design system, for example: "Propose a design system
        for this project: calm, high contrast, one blue accent, light and dark modes."
      </p>
      <p className="text-muted-foreground">
        Agents use the <code className="font-mono text-xs">design_system_propose</code> tool. Their
        proposal appears under Pending proposals on this page, and nothing is saved until you review
        and confirm it.
      </p>
    </div>
  );
}

export function NewDesignSystemDialog({
  mode,
  onModeChange,
  onOpenChange,
  projects,
  defaultProjectId,
  figma,
  onScan,
  onPropose,
}: {
  mode: NewSystemMode;
  onModeChange: (mode: NewSystemMode) => void;
  onOpenChange: (open: boolean) => void;
  projects: readonly OwnerProject[];
  defaultProjectId?: ProjectId | null;
  figma: FigmaStatusView;
  onScan: (projectId: ProjectId) => Promise<ScanOutcome>;
  /** Resolves to an error message, or null once the review is open. */
  onPropose: (input: DesignSystemProposeInput) => Promise<string | null>;
}) {
  const defaultOwner: DesignOwnerInput =
    defaultProjectId != null
      ? { kind: "project", projectId: defaultProjectId }
      : projects[0]
        ? { kind: "project", projectId: projects[0].id }
        : { kind: "playground" };
  const title = NEW_SYSTEM_MODES.find((entry) => entry.mode === mode)?.label ?? "";
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl" data-testid="new-design-system-dialog" data-mode={mode}>
        <DialogHeader>
          <DialogTitle>
            New design system: {title.charAt(0).toLowerCase() + title.slice(1)}
          </DialogTitle>
          <DialogDescription>
            The app reads the source and shows a review. Only what you confirm is saved.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {mode === "code" ? (
            <ScanFromCode projects={projects} onScan={onScan} onPropose={onPropose} />
          ) : mode === "tokens-file" ? (
            <TokensFilePanel
              projects={projects}
              defaultOwner={defaultOwner}
              onPropose={onPropose}
            />
          ) : mode === "figma" ? (
            <FigmaPanel
              projects={projects}
              defaultOwner={defaultOwner}
              figma={figma}
              onPropose={onPropose}
              onUseFile={() => onModeChange("tokens-file")}
            />
          ) : (
            <DescribePanel />
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
