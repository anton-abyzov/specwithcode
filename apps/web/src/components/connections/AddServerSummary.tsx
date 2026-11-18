import { useState, type ReactNode } from "react";
import type {
  EnvironmentId,
  NativeConnectionsSnapshot,
  NativeTool,
} from "@specweave-studio/contracts";

import { useLocale, useTx } from "../../i18n";
import { MaskedFieldGlyph } from "../chat/MaskedFieldGlyph";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toolLabels } from "./ConnectionMatrix";
import {
  shownCommand,
  toolChoices,
  type OtherMachineState,
  type SecretField,
  type ToolChoice,
} from "./addServerPlan";
import type { CatalogEntry } from "./serverCatalog";
import { SERVER_NAME, type ServerDraft } from "./serverPaste";

/** Another machine under "Also add on": ready to tick, or listed with why it cannot be. */
export interface OtherMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly state: OtherMachineState;
  readonly reason: string | null;
}

interface SummaryState {
  readonly draft: ServerDraft;
  readonly entry: CatalogEntry | null;
  readonly fields: ReadonlyArray<SecretField>;
  readonly tools: ReadonlyArray<NativeTool>;
  readonly machines: ReadonlyArray<EnvironmentId>;
}

function Part({
  number,
  title,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h5 className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden
          className="flex size-5 items-center justify-center rounded-full bg-muted text-xs"
        >
          {number}
        </span>
        {title}
      </h5>
      <div className="space-y-2 sm:pl-7">{children}</div>
    </section>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid gap-x-3 gap-y-0.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** The day a catalog entry was checked, in the window's language. */
function checkedDay(day: string, locale: string) {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(locale, { dateStyle: "long" });
}

/** The summary of a server before it is added: what, which AI tools, and on which machines. */
export function AddServerSummary({
  machine,
  snapshot,
  project,
  adding,
  others,
  problem,
  pending,
  list,
  onChange,
  onReview,
  onCancel,
  onByHand,
}: {
  readonly machine: string;
  readonly snapshot: NativeConnectionsSnapshot;
  readonly project: boolean;
  readonly adding: SummaryState;
  readonly others: ReadonlyArray<OtherMachine>;
  readonly problem: string | null;
  readonly pending: boolean;
  readonly list: (names: ReadonlyArray<string>) => string;
  readonly onChange: (next: Partial<SummaryState>) => void;
  readonly onReview: () => void;
  readonly onCancel: () => void;
  readonly onByHand: () => void;
}) {
  const tx = useTx();
  const locale = useLocale();
  const [renaming, setRenaming] = useState(false);
  const { draft, entry, fields } = adding;
  const choices = toolChoices(snapshot, draft);
  const nameFits = SERVER_NAME.test(draft.name);
  const web = draft.kind === "http";
  const where = [
    machine,
    ...others
      .filter((other) => adding.machines.includes(other.environmentId))
      .map((other) => other.label),
  ];

  function blockedReason(choice: ToolChoice) {
    const tool = toolLabels[choice.tool];
    if (choice.blocked === "taken")
      return tx("{tool} already has a server named {name}", { tool, name: draft.name });
    return web
      ? tx("SpecWithCode cannot add web addresses to {tool}", { tool })
      : tx("SpecWithCode cannot add programs to {tool}", { tool });
  }

  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      data-testid="add-server-summary"
      onSubmit={(event) => {
        event.preventDefault();
        onReview();
      }}
    >
      <div>
        <h4 className="text-sm font-medium">
          {tx("Add {name}", { name: entry?.title ?? draft.name })}
        </h4>
        {entry ? <p className="text-sm text-muted-foreground">{tx(entry.about)}</p> : null}
      </div>

      <Part number={1} title={tx("What will be added")}>
        <dl className="space-y-1.5">
          <Row label={tx("Name")}>
            {renaming ? (
              <span className="flex flex-wrap items-center gap-2">
                <Input
                  value={draft.name}
                  aria-label={tx("Server name")}
                  aria-invalid={!nameFits || undefined}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="max-w-56"
                  onChange={(event) =>
                    onChange({ draft: { ...draft, name: event.target.value.trim() } })
                  }
                />
                <Button type="button" variant="outline" onClick={() => setRenaming(false)}>
                  {tx("Done")}
                </Button>
              </span>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <code data-testid="add-server-name">{draft.name}</code>
                <Button type="button" variant="outline" onClick={() => setRenaming(true)}>
                  {tx("Rename")}
                </Button>
              </span>
            )}
          </Row>
          <Row label={tx("Kind")}>{web ? tx("Web address") : tx("Program on this machine")}</Row>
          {web ? (
            <Row label={tx("Address")}>{draft.server.url}</Row>
          ) : (
            <Row label={tx("Command")}>
              <code data-testid="add-server-command">{shownCommand(draft)}</code>
            </Row>
          )}
          {entry ? (
            <Row label={tx("Sign-in")}>{tx(entry.signInText)}</Row>
          ) : web && fields.length === 0 ? (
            <Row label={tx("Sign-in")}>{tx("If it needs one, you sign in after you add it.")}</Row>
          ) : null}
          {fields.map((field, index) => {
            const label =
              field.where === "header" && entry?.token?.header === field.key
                ? tx(entry.token.label)
                : field.key;
            const id = `add-server-secret-${index}`;
            return (
              <Row
                key={`${field.where}:${field.key}:${field.index}`}
                label={field.where === "header" ? tx("Header") : tx("Secret value")}
              >
                <label htmlFor={id} className="flex items-center gap-1.5 pb-1">
                  <MaskedFieldGlyph className="size-4 text-muted-foreground" />
                  {label}
                </label>
                <span className="flex items-center gap-2">
                  {field.prefix ? (
                    <span className="text-muted-foreground">{field.prefix.trim()}</span>
                  ) : null}
                  <Input
                    id={id}
                    // A real password field: a text field masked with CSS still
                    // exposes its value to screen readers.
                    type="password"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    // Password managers otherwise offer to save or fill this field.
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    value={field.value}
                    className="max-w-72"
                    onChange={(event) =>
                      onChange({
                        fields: fields.map((value, position) =>
                          position === index ? { ...value, value: event.target.value } : value,
                        ),
                      })
                    }
                  />
                </span>
              </Row>
            );
          })}
          {entry?.plan || !web ? (
            <Row label={tx("Good to know")}>
              {web
                ? tx(entry?.plan ?? "")
                : tx(
                    "This is a program. It will run on each machine you tick, with your account's rights.",
                  )}
            </Row>
          ) : null}
          {entry ? (
            <Row label={tx("Source")}>
              {tx("Checked on {date} against", { date: checkedDay(entry.checked, locale) })}{" "}
              <a
                href={entry.page}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-4"
              >
                {entry.page.replace(/^https:\/\//, "").replace(/\/$/, "")}
              </a>
            </Row>
          ) : null}
        </dl>
      </Part>

      <Part number={2} title={tx("Which AI tools get it")}>
        <ul className="space-y-1.5" data-testid="add-server-tools">
          {choices.map((choice) => {
            const label = toolLabels[choice.tool];
            const checked = choice.blocked === null && adding.tools.includes(choice.tool);
            return (
              <li key={choice.tool}>
                <label className="flex min-h-8 flex-wrap items-center gap-x-2 text-sm">
                  <Checkbox
                    aria-label={label}
                    checked={checked}
                    disabled={choice.blocked !== null}
                    onCheckedChange={(next) =>
                      onChange({
                        tools: next
                          ? [...adding.tools.filter((tool) => tool !== choice.tool), choice.tool]
                          : adding.tools.filter((tool) => tool !== choice.tool),
                      })
                    }
                  />
                  {choice.blocked === null ? (
                    label
                  ) : (
                    <span className="text-muted-foreground">{blockedReason(choice)}</span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          {tx(
            "Each tool keeps its own list. A thread sees this server when the tool it runs on is ticked. Grok threads read Claude Code's list.",
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {tx(
            "Other AI tools, such as Cursor or Gemini CLI, appear here once they are installed on {machine}.",
            { machine },
          )}
        </p>
      </Part>

      <Part number={3} title={tx("Where")}>
        <p className="text-sm" data-testid="add-server-where">
          {where.length === 1
            ? tx("On {machine} only.", { machine })
            : tx("On {machines}.", { machines: list(where) })}
        </p>
        {project ? (
          <p className="text-xs text-muted-foreground">
            {tx("Added for every project on {machines}.", { machines: list(where) })}
          </p>
        ) : null}
        {others.length > 0 ? (
          <fieldset className="space-y-1.5" data-testid="add-server-machines">
            <legend className="pb-1 text-sm text-muted-foreground">{tx("Also add on")}</legend>
            {others.map((other) => (
              <label
                key={other.environmentId}
                className="flex min-h-8 flex-wrap items-center gap-x-2 text-sm"
              >
                <Checkbox
                  aria-label={other.label}
                  checked={other.state === "ready" && adding.machines.includes(other.environmentId)}
                  disabled={other.state !== "ready"}
                  onCheckedChange={(next) =>
                    onChange({
                      machines: next
                        ? [
                            ...adding.machines.filter((id) => id !== other.environmentId),
                            other.environmentId,
                          ]
                        : adding.machines.filter((id) => id !== other.environmentId),
                    })
                  }
                />
                {other.reason === null ? (
                  other.label
                ) : (
                  <span className="text-muted-foreground">{other.reason}</span>
                )}
              </label>
            ))}
          </fieldset>
        ) : null}
      </Part>

      {problem ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? tx("Checking…") : tx("Review")}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          {tx("Cancel")}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={onByHand}>
          {tx("Enter details by hand")}
        </Button>
      </div>
    </form>
  );
}
