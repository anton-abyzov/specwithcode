/**
 * The "+ Add" dialog of a token section: a name, the group it joins (groups
 * are name prefixes, as the tables show them), its value per mode where the
 * section has one, and a usage note.
 */
import type { DesignSystem, DesignTokenEdit, DesignTokenType } from "@specweave-studio/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../../ui/select";
import { Textarea } from "../../../ui/textarea";
import {
  groupNamePrefix,
  groupTokensByName,
  type SystemSection,
  type TokenSectionKind,
} from "./systemSections";
import {
  colorProblem,
  hexOf,
  inferValueType,
  lengthProblem,
  parseColor,
  plainValueProblem,
  shadowProblem,
  tokenNameProblem,
  withTracking,
} from "./tokenValues";
import { DialogConflictNotice } from "./DialogConflictNotice";
import {
  DEFAULT_TYPE_DRAFT,
  typeDraftProblem,
  typeDraftRaw,
  TypeFields,
  type TypeDraft,
} from "./TypographyTable";

const NONE = "__none__";
const NEW = "__new__";

const KIND_TEXT: Record<
  TokenSectionKind,
  { noun: string; placeholder: string; defaultValue: string; group: "Group" | "Set" }
> = {
  colors: { noun: "color", placeholder: "e.g. brand-500", defaultValue: "", group: "Group" },
  typography: {
    noun: "type style",
    placeholder: "e.g. heading-lg",
    defaultValue: "",
    group: "Set",
  },
  spacing: {
    noun: "spacing value",
    placeholder: "e.g. space-md",
    defaultValue: "8px",
    group: "Group",
  },
  radius: {
    noun: "corner radius",
    placeholder: "e.g. radius-md",
    defaultValue: "4px",
    group: "Group",
  },
  shadows: { noun: "shadow", placeholder: "e.g. shadow-sm", defaultValue: "", group: "Group" },
  family: { noun: "token", placeholder: "e.g. token-1", defaultValue: "1", group: "Group" },
};

const TYPES: Record<Exclude<TokenSectionKind, "family">, DesignTokenType> = {
  colors: "color",
  typography: "typography",
  spacing: "dimension",
  radius: "dimension",
  shadows: "shadow",
};

const BLACK = { r: 0, g: 0, b: 0 };
const GROUP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The name a token is saved under: the group's prefix joined to what was typed. */
export function nameInGroup(typed: string, group: string, prefix: string): string {
  const name = typed.trim();
  if (group === "") return name;
  const full = `${prefix}${group}-`;
  if (name.startsWith(full)) return name;
  if (prefix !== "" && name.startsWith(`${group}-`)) return `${prefix}${name}`;
  return `${full}${name}`;
}

export function AddTokenDialog({
  section,
  system,
  initialGroup,
  conflict = false,
  onReload,
  onOpenChange,
  onAdd,
}: {
  section: SystemSection & { kind: TokenSectionKind };
  system: DesignSystem;
  /** A group key from a group header's "+", or null for the section's "+ Add". */
  initialGroup: string | null;
  /** The last save hit a revision conflict; Add waits for Reload. */
  conflict?: boolean;
  onReload?: () => void;
  onOpenChange: (open: boolean) => void;
  /** Resolves true once saved. */
  onAdd: (token: DesignTokenEdit) => Promise<boolean>;
}) {
  const id = useId();
  const text = KIND_TEXT[section.kind];
  const pool =
    section.kind === "typography"
      ? section.tokens.filter((token) => token.type === "typography")
      : section.tokens;
  const groups = groupTokensByName(pool).filter((group) => group.key !== "");
  const prefix = groupNamePrefix(pool);
  const modes = system.modes;
  const perMode = section.kind === "colors" || section.kind === "shadows";

  const [name, setName] = useState("");
  // A name is saved as typed unless a group is chosen: preselecting the only group renamed
  // "body-md" to "heading-body-md" without asking.
  const [group, setGroup] = useState<string>(initialGroup ?? NONE);
  const [newGroup, setNewGroup] = useState("");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(modes.map((mode, index) => [mode.id, index === 0 ? text.defaultValue : ""])),
  );
  const [typeDraft, setTypeDraft] = useState<TypeDraft>(DEFAULT_TYPE_DRAFT);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  // A ref, so a second Enter in the same tick cannot queue a second add.
  const sending = useRef(false);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!conflict) setRefused(false);
  }, [conflict]);

  const groupKey = group === NONE ? "" : group === NEW ? newGroup.trim() : group;
  const groupProblem =
    group === NEW && !GROUP_NAME.test(newGroup.trim())
      ? "A group name uses lowercase letters, digits and single hyphens."
      : null;
  const finalName = nameInGroup(name, groupKey, prefix);
  const existing = system.tokens.map((token) => token.name);
  const nameProblem = name.trim() === "" && !tried ? null : tokenNameProblem(finalName, existing);
  const colorNames = system.tokens.filter((t) => t.type === "color").map((t) => t.name);
  const baseId = modes[0]?.id ?? "default";

  const valueProblem = (modeId: string): string | null => {
    const raw = values[modeId] ?? "";
    if (modeId !== baseId && raw.trim() === "") return null;
    switch (section.kind) {
      case "colors":
        return colorProblem(raw, finalName, colorNames);
      case "shadows":
        return shadowProblem(raw);
      case "spacing":
      case "radius":
        return lengthProblem(raw);
      case "family":
        return plainValueProblem(raw);
      case "typography":
        return null;
    }
  };
  const valueModes = perMode ? modes : modes.slice(0, 1);
  const problems = [
    tokenNameProblem(finalName, existing),
    groupProblem,
    section.kind === "typography" ? typeDraftProblem(typeDraft) : null,
    ...valueModes.map((mode) => valueProblem(mode.id)),
  ].filter((problem) => problem !== null);

  const submit = async () => {
    setTried(true);
    if (problems.length > 0 || conflict || sending.current) return;
    const baseRaw = values[baseId] ?? "";
    const type: DesignTokenType =
      section.kind === "family"
        ? (() => {
            const inferred = inferValueType(baseRaw);
            // A color typed into a family stays in the family, not in Colors.
            return inferred === "color" ? "other" : inferred;
          })()
        : TYPES[section.kind];
    const tokenValues =
      section.kind === "typography"
        ? { [baseId]: typeDraftRaw(typeDraft) }
        : Object.fromEntries(
            valueModes
              .map((mode) => [mode.id, (values[mode.id] ?? "").trim()] as const)
              .filter(([, raw]) => raw !== ""),
          );
    const description =
      section.kind === "typography" ? withTracking(note, typeDraft.tracking || null) : note.trim();
    sending.current = true;
    setBusy(true);
    const saved = await onAdd({
      name: finalName,
      type,
      group: section.group,
      values: tokenValues,
      ...(description === "" ? {} : { description }),
    });
    sending.current = false;
    setBusy(false);
    if (saved) onOpenChange(false);
    else setRefused(true);
  };

  const shownName = finalName === "" ? "it" : finalName;
  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogPopup className="sm:max-w-lg" data-testid="add-token-dialog" data-kind={section.kind}>
        <DialogHeader>
          <DialogTitle>
            Add {text.noun} to {section.title}
          </DialogTitle>
          <DialogDescription>
            It is saved in this design system right away; Undo takes it back.
          </DialogDescription>
          {conflict && onReload ? (
            <DialogConflictNotice refused={refused} onReload={onReload} />
          ) : null}
        </DialogHeader>
        <DialogPanel>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                size="sm"
                font="mono"
                autoFocus
                spellCheck={false}
                placeholder={text.placeholder}
                value={name}
                aria-invalid={nameProblem !== null}
                onChange={(event) => setName(event.target.value)}
              />
              {nameProblem !== null ? (
                <span role="alert" className="text-destructive-foreground text-xs">
                  {nameProblem}
                </span>
              ) : finalName !== name.trim() && name.trim() !== "" ? (
                <span className="text-muted-foreground text-xs">
                  Saved as <span className="font-mono">{finalName}</span>
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-group`}>{text.group}</Label>
              <Select value={group} onValueChange={(value) => value !== null && setGroup(value)}>
                <SelectTrigger id={`${id}-group`} size="sm" data-testid="add-token-group">
                  <SelectValue>
                    {group === NONE
                      ? section.kind === "colors"
                        ? "Palette"
                        : "None"
                      : group === NEW
                        ? `New ${text.group.toLowerCase()}…`
                        : group}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={NONE}>
                    {section.kind === "colors" ? "Palette" : "None"}
                  </SelectItem>
                  {groups.map((candidate) => (
                    <SelectItem key={candidate.key} value={candidate.key}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW}>New {text.group.toLowerCase()}…</SelectItem>
                </SelectPopup>
              </Select>
              {group === NEW ? (
                <>
                  <Input
                    size="sm"
                    font="mono"
                    aria-label={`${text.group} name`}
                    placeholder="e.g. accent"
                    value={newGroup}
                    spellCheck={false}
                    onChange={(event) => setNewGroup(event.target.value)}
                  />
                  {groupProblem !== null && (tried || newGroup !== "") ? (
                    <span role="alert" className="text-destructive-foreground text-xs">
                      {groupProblem}
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
            {section.kind === "typography" ? (
              <TypeFields
                draft={typeDraft}
                onChange={setTypeDraft}
                families={system.tokens.filter((token) => token.type === "fontFamily")}
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {valueModes.map((mode, index) => {
                  const problem =
                    tried || (values[mode.id] ?? "") !== "" ? valueProblem(mode.id) : null;
                  return (
                    <div key={mode.id} className="flex flex-col gap-1.5">
                      <Label htmlFor={`${id}-${mode.id}`}>{perMode ? mode.name : "Value"}</Label>
                      <div className="flex items-center gap-2">
                        {section.kind === "colors" ? (
                          <input
                            type="color"
                            aria-label={`Pick a color for ${mode.name}`}
                            className="h-7 w-9 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                            value={hexOf(parseColor(values[mode.id] ?? "") ?? BLACK).toLowerCase()}
                            onChange={(event) =>
                              setValues((current) => ({
                                ...current,
                                [mode.id]: event.target.value,
                              }))
                            }
                          />
                        ) : null}
                        <Input
                          id={`${id}-${mode.id}`}
                          size="sm"
                          font="mono"
                          spellCheck={false}
                          value={values[mode.id] ?? ""}
                          placeholder={
                            index === 0
                              ? section.kind === "colors"
                                ? "#595ecc"
                                : section.kind === "shadows"
                                  ? "0 1px 2px rgba(0,0,0,.2)"
                                  : text.defaultValue
                              : `Same as ${modes[0]?.name ?? "the first mode"}`
                          }
                          aria-invalid={problem !== null}
                          onChange={(event) =>
                            setValues((current) => ({ ...current, [mode.id]: event.target.value }))
                          }
                        />
                      </div>
                      {problem !== null ? (
                        <span role="alert" className="text-destructive-foreground text-xs">
                          {problem}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-note`}>Usage note</Label>
              <Textarea
                id={`${id}-note`}
                size="sm"
                placeholder={`Optional: when should agents use ${shownName}?`}
                value={note}
                maxLength={2_000}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <button type="submit" hidden aria-hidden tabIndex={-1} />
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy || conflict}
            data-testid="add-token-submit"
            onClick={() => void submit()}
          >
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
