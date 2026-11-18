import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  NativeConnectionChange,
  NativeTool,
} from "@specweave-studio/contracts";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import { ChangeFiles } from "./ConnectionEditor";
import { toolLabels } from "./ConnectionMatrix";
import { signInCommands, signInStep, type MachinePlan } from "./addServerPlan";
import { BUILT_IN_TOOLS } from "./builtInTools";
import type { CatalogEntry } from "./serverCatalog";
import type { BuiltInOverlap, ServerDraft } from "./serverPaste";

/** What one machine would write, or why it cannot take the server. */
export interface MachineReview {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The tools this machine is asked to write for. */
  readonly tools: ReadonlyArray<NativeTool>;
  /** Ticked tools left out on this machine. */
  readonly dropped: MachinePlan["dropped"];
  /** The machine's own answer to the preview; null when it was refused or never asked. */
  readonly files: NativeConnectionChange["files"] | null;
  readonly refusal: string | null;
}

/** What the last apply did on one machine. */
export interface MachineResult {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly tools: ReadonlyArray<NativeTool>;
  readonly state: "added" | "failed" | "skipped" | "undone";
  /** Undoes this machine's write and no other. */
  readonly changeId: string | null;
  readonly reason: string | null;
}

const RESULT_TEXT: Record<MachineResult["state"], string> = {
  added: "Added",
  failed: "Not added",
  skipped: "Skipped",
  undone: "Undone",
};

function useDroppedNote(name: string) {
  const tx = useTx();
  return (machine: string, drop: MachinePlan["dropped"][number]) => {
    const tool = toolLabels[drop.tool];
    if (drop.why === "missing")
      return tx("{tool} is not installed on {machine}, so it is left out there.", {
        tool,
        machine,
      });
    if (drop.why === "taken")
      return tx("{tool} on {machine} already has a server named {name}, so it is left out there.", {
        tool,
        machine,
        name,
      });
    return tx("SpecWithCode cannot add this kind of server to {tool}, so it is left out there.", {
      tool,
    });
  };
}

/** A built-in tool already does part of what this server does: say so before adding it. */
export function AddServerOverlap({
  overlap,
  onAdd,
  onCancel,
}: {
  readonly overlap: BuiltInOverlap;
  readonly onAdd: () => void;
  readonly onCancel: () => void;
}) {
  const tx = useTx();
  const builtIn = BUILT_IN_TOOLS.find((tool) => tool.id === overlap.tool)!;
  return (
    <div
      role="alertdialog"
      aria-labelledby="add-server-overlap-title"
      aria-describedby="add-server-overlap-text"
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="add-server-overlap"
    >
      <h4 id="add-server-overlap-title" className="text-sm font-medium">
        {tx("This overlaps with something built in")}
      </h4>
      <p id="add-server-overlap-text" className="text-sm text-muted-foreground">
        {tx(overlap.builtIn)} {tx(overlap.adds)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={builtIn.to}
          hash={builtIn.hash}
          className="inline-flex min-h-8 items-center rounded-md px-1 text-sm text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
        >
          {tx(overlap.link)}
        </Link>
        <Button variant="outline" onClick={onAdd}>
          {tx("Add anyway")}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {tx("Cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Every machine's own files, or its reason, before anything is written. */
export function AddServerReview({
  name,
  machines,
  pending,
  list,
  onSave,
  onBack,
}: {
  readonly name: string;
  readonly machines: ReadonlyArray<MachineReview>;
  readonly pending: boolean;
  readonly list: (names: ReadonlyArray<string>) => string;
  readonly onSave: () => void;
  readonly onBack: () => void;
}) {
  const tx = useTx();
  const note = useDroppedNote(name);
  const writable = machines.filter((machine) => machine.files !== null);
  return (
    <div
      role="dialog"
      aria-label={tx("Review the change")}
      className="space-y-3 rounded-lg border border-border p-4"
      data-testid="add-server-review"
    >
      <div>
        <h4 className="text-sm font-medium">{tx("Review the change")}</h4>
        <p className="text-xs text-muted-foreground">
          {tx("Nothing is written until you save. A backup is kept, so you can undo.")}
        </p>
      </div>
      {machines.map((machine) => (
        <section
          key={machine.environmentId}
          className="space-y-1.5 border-t border-border/60 pt-3"
          data-testid="review-machine"
          data-machine={machine.label}
        >
          {machine.files !== null ? (
            <>
              <h5 className="text-sm font-medium">{machine.label}</h5>
              <ChangeFiles files={machine.files} />
              {machine.dropped.map((drop) => (
                <p key={drop.tool} className="text-xs text-muted-foreground">
                  {note(machine.label, drop)}
                </p>
              ))}
            </>
          ) : (
            <>
              <h5 className="text-sm font-medium">
                {tx("Cannot be added on {machine}", { machine: machine.label })}
              </h5>
              {machine.refusal ? (
                <p className="text-sm text-muted-foreground">{machine.refusal}</p>
              ) : null}
              {machine.dropped.map((drop) => (
                <p key={drop.tool} className="text-sm text-muted-foreground">
                  {note(machine.label, drop)}
                </p>
              ))}
              <p className="text-sm text-muted-foreground">
                {tx("{machine} will be skipped.", { machine: machine.label })}
              </p>
            </>
          )}
        </section>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || writable.length === 0} onClick={onSave}>
          {pending
            ? tx("Saving…")
            : writable.length === 0
              ? tx("Save")
              : tx("Save on {machines}", {
                  machines: list(writable.map((machine) => machine.label)),
                })}
        </Button>
        <Button variant="outline" disabled={pending} onClick={onBack}>
          {tx("Back")}
        </Button>
      </div>
    </div>
  );
}

function CopyCommand({ command }: { readonly command: string }) {
  const tx = useTx();
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ target: command });
  return (
    <Button
      variant="outline"
      aria-label={`${tx("Copy")}: ${command}`}
      onClick={() => copyToClipboard(command, undefined)}
    >
      {isCopied ? tx("Copied") : tx("Copy")}
    </Button>
  );
}

/** Each machine's result with its own Undo, and the sign-in still left to do. */
export function AddServerDone({
  final,
  entry,
  results,
  problem,
  busy,
  list,
  onUndo,
  onClose,
}: {
  readonly final: ServerDraft;
  readonly entry: CatalogEntry | null;
  readonly results: ReadonlyArray<MachineResult>;
  readonly problem: string | null;
  readonly busy: string | null;
  readonly list: (names: ReadonlyArray<string>) => string;
  readonly onUndo: (index: number) => void;
  readonly onClose: () => void;
}) {
  const tx = useTx();
  const added = results.filter((result) => result.state === "added");
  const step = signInStep(final, entry);
  const commands = signInCommands(final.name, [
    ...new Set(added.flatMap((result) => result.tools)),
  ]);
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-testid="add-server-done">
      <h4 className="text-sm font-medium">{tx("Where it was added")}</h4>
      <ul className="space-y-1.5">
        {results.map((result, index) => (
          <li
            key={result.environmentId}
            className="flex flex-wrap items-center gap-2 text-sm"
            data-testid="add-server-result"
            data-state={result.state}
          >
            <span className="font-medium">{result.label}</span>
            <span role="status">{tx(RESULT_TEXT[result.state])}</span>
            {result.reason ? <span className="text-muted-foreground">{result.reason}</span> : null}
            {result.state === "added" && result.changeId ? (
              <Button
                variant="outline"
                disabled={busy !== null}
                aria-label={`${tx("Undo")}: ${result.label}`}
                onClick={() => onUndo(index)}
              >
                {busy === `undo:${index}` ? tx("Undoing…") : tx("Undo")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {problem ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      ) : null}
      {step && commands.length > 0 ? (
        <section
          className="space-y-2 border-t border-border/60 pt-3"
          data-testid="add-server-sign-in"
        >
          <h5 className="text-sm font-medium">
            {step === "browser"
              ? tx("One step left: sign in once in each tool")
              : tx("If this server asks you to sign in, do it once in each tool")}
          </h5>
          <p className="text-sm text-muted-foreground">
            {step === "browser"
              ? tx(
                  "{server} opens a browser window to sign in. SpecWithCode cannot see whether you are signed in, so it does not guess.",
                  { server: entry?.title ?? final.name },
                )
              : tx(
                  "Some servers open a browser window to sign in. SpecWithCode cannot see whether you are signed in, so it does not guess.",
                )}
          </p>
          <ul className="space-y-1.5">
            {commands.map(({ tool, command }) => (
              <li key={tool} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-24">{toolLabels[tool]}</span>
                <code className="rounded bg-muted px-1.5 py-1 text-xs">{command}</code>
                <CopyCommand command={command} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {tx("Run it in a terminal on {machines}.", {
              machines: list(added.map((result) => result.label)),
            })}
          </p>
        </section>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {tx("Tools pick the change up when they next start.")}
      </p>
      <Button variant="outline" onClick={onClose}>
        {tx("Done")}
      </Button>
    </div>
  );
}
