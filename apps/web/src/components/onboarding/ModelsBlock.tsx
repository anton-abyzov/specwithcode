import { useAtomValue } from "@effect/atom-react";
import { providerInstanceInitials } from "@specweave-studio/client-runtime/state/provider-instance-display";
import { type EnvironmentId, MODEL_TRACK_LABELS } from "@specweave-studio/contracts";
import { Fragment, lazy, type ReactNode, Suspense, useMemo, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import {
  firstRunModels,
  type ModelLine,
  type ModelLineEntry,
  type ReviewerExample,
} from "../../onboarding/firstRunModels.logic";
import { serverEnvironment } from "../../state/server";
import { ProviderLogo, type ProviderBrand } from "../ProviderLogo";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { SettingsScopeProvider } from "../settings/SettingsScopeContext";
import type { SettingsScopeSearch } from "../settings/settingsScope";

const ModelTracksSettings = lazy(() =>
  import("../settings/ModelTracksSettings").then((module) => ({
    default: module.ModelTracksSettings,
  })),
);

/** The scope stays on this machine: the dialog has no scope picker to move it. */
const KEEP_SCOPE = () => {};

/** Rows the step draws for a machine's tools (`MachineReadinessToolId`), not its agents. */
const TOOL_ROWS = ["git", "node", "gh", "specweave"];

/**
 * "Add one": focus moves to the first agent row on this machine that is not
 * ready, onto its first button when it has one. Tool rows are skipped.
 */
export function focusFirstAgentNotReady(from: Element | null): boolean {
  const section = from?.closest("section") ?? null;
  const row = section?.querySelector<HTMLElement>(
    `[data-agent-row]${TOOL_ROWS.map((tool) => `:not([data-agent-row="${tool}"])`).join("")}:not([data-agent-state="ready"])`,
  );
  if (!row) return false;
  const control = row.querySelector<HTMLElement>("button:not([disabled]), a[href], input");
  if (control) {
    control.focus();
    return true;
  }
  row.tabIndex = -1;
  row.focus();
  return true;
}

function Mark(props: { readonly brand: ProviderBrand | null; readonly name: string }) {
  if (props.brand !== null) return <ProviderLogo brand={props.brand} className="size-3.5" />;
  // No bundled brand: the app's own fallback, the name's initials, never another provider's mark.
  return (
    <span
      aria-hidden
      className="inline-flex size-3.5 shrink-0 items-center justify-center text-4xs font-semibold text-muted-foreground"
    >
      {providerInstanceInitials(props.name)}
    </span>
  );
}

function Named(props: { readonly entry: ModelLineEntry | ReviewerExample; readonly first?: boolean }) {
  const tx = useTx();
  return (
    <span className="inline-flex items-center gap-1 align-middle" data-model-name={props.entry.name}>
      <Mark brand={props.entry.brand} name={props.entry.name} />
      <span>{props.entry.name}</span>
      {props.first ? (
        <Badge variant="outline" size="sm" data-model-first>
          {tx("first")}
        </Badge>
      ) : null}
    </span>
  );
}

function LineBody(props: { readonly line: ModelLine; readonly onAddOne: () => void }) {
  const tx = useTx();
  const { line } = props;
  if (line.kind === "empty") {
    return (
      <span className="text-muted-foreground">
        {tx("None of the ready agents runs a model on this list.")}
      </span>
    );
  }
  if (line.kind === "no-reviewer") {
    const [one, two] = line.examples;
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          <span className="font-medium text-warning-foreground">{tx("No reviewer yet.")}</span>{" "}
          {renderRich(
            tx("A review needs a model from a second family, such as {first} or {second}."),
            { first: <Named entry={one} />, second: <Named entry={two} /> },
          )}
        </span>
        <Button type="button" size="xs" variant="outline" onClick={props.onAddOne}>
          {tx("Add one")}
        </Button>
      </span>
    );
  }
  const parts: ReactNode[] = line.shown.map((entry, index) => (
    <Fragment key={entry.key}>
      {index > 0 ? ", " : null}
      <Named entry={entry} first={index === 0} />
    </Fragment>
  ));
  return (
    <span>
      {parts}
      {line.more > 0 ? (
        <span className="text-muted-foreground">
          {" "}
          {tx("+{n} more", { n: line.more })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The Models block under one machine's agent rows: the three tracks this
 * machine will use, in order, fitted to its agents that are ready. It stores
 * nothing; Change opens the Settings > Models editor for this machine.
 */
export function ModelsBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
}) {
  const tx = useTx();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const settings = config?.settings;
  const models = useMemo(
    () =>
      firstRunModels({
        settings: settings ?? { adversarialReview: { reviewers: [] } },
        providers: config?.providers,
      }),
    [config?.providers, settings],
  );
  const [editing, setEditing] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const scope = useMemo<SettingsScopeSearch>(
    () => ({ machine: props.environmentId }),
    [props.environmentId],
  );

  return (
    <div
      ref={root}
      className="mt-3 rounded-lg border border-border bg-background px-3 py-2.5"
      data-models-block
      data-models-state={models.kind}
    >
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{tx("Models")}</h3>
        <Button type="button" size="xs" variant="outline" onClick={() => setEditing(true)}>
          {tx("Change")}
        </Button>
      </div>
      {models.kind === "none-ready" ? (
        <p className="text-sm text-muted-foreground" data-model-track="daily" data-model-line="empty">
          {tx("Ready once an agent is signed in.")}
        </p>
      ) : (
        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm max-sm:grid-cols-1 max-sm:gap-y-0.5">
          {models.lines.map((line) => (
            <Fragment key={line.track}>
              <dt className="text-muted-foreground">{tx(MODEL_TRACK_LABELS[line.track])}</dt>
              <dd
                className="m-0 min-w-0 leading-relaxed max-sm:mb-1.5"
                data-model-track={line.track}
                data-model-line={line.kind}
              >
                <LineBody line={line} onAddOne={() => focusFirstAgentNotReady(root.current)} />
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {editing ? (
        <Dialog open onOpenChange={(open) => (open ? null : setEditing(false))}>
          <DialogPopup className="w-[min(760px,calc(100vw-32px))] max-w-none" data-models-editor>
            <DialogHeader>
              <DialogTitle>{tx("Models")}</DialogTitle>
              <DialogDescription>{props.machineLabel}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <SettingsScopeProvider search={scope} onChange={KEEP_SCOPE} singleEnvironment>
                <Suspense fallback={null}>
                  <ModelTracksSettings sources={false} />
                </Suspense>
              </SettingsScopeProvider>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
