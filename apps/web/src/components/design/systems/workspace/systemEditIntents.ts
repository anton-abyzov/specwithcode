/**
 * What a person does on the design system page, as `designSystem.apply`
 * operations, plus the operations that undo them. The server checks the
 * revision, resolves values and stamps user provenance. Pure.
 */
import type {
  DesignSystem,
  DesignSystemComponent,
  DesignSystemComponentEdit,
  DesignSystemOperation,
  DesignToken,
  DesignTokenEdit,
} from "@specweave-studio/contracts";

import { aliasTarget } from "./tokenValues";

export type SystemEditIntent =
  /** One mode's value; `null` copies the first mode's value into a later mode. */
  | {
      readonly kind: "set-value";
      readonly name: string;
      readonly modeId: string;
      readonly raw: string | null;
    }
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | { readonly kind: "remove"; readonly name: string }
  /** The usage note; empty removes it. */
  | { readonly kind: "set-usage"; readonly name: string; readonly text: string }
  | { readonly kind: "add"; readonly token: DesignTokenEdit }
  /** A whole token, for edits that change its value and its note together (typography). */
  | { readonly kind: "replace"; readonly token: DesignTokenEdit }
  | { readonly kind: "set-info"; readonly name?: string; readonly description?: string | null }
  | { readonly kind: "put-mode"; readonly id: string; readonly name: string }
  | { readonly kind: "delete-mode"; readonly id: string }
  | { readonly kind: "put-component"; readonly component: DesignSystemComponentEdit }
  | { readonly kind: "remove-component"; readonly id: string };

/** A stored token as the person would write it again: raw values only. */
export function tokenToEdit(token: DesignToken): DesignTokenEdit {
  const values: Record<string, string> = {};
  for (const [modeId, value] of Object.entries(token.values)) values[modeId] = value.raw;
  return {
    name: token.name,
    type: token.type,
    ...(token.group !== undefined ? { group: token.group } : {}),
    ...(token.description !== undefined ? { description: token.description } : {}),
    values,
    ...(token.aliasOf !== undefined ? { aliasOf: token.aliasOf } : {}),
  };
}

function componentToEdit(component: DesignSystemComponent): DesignSystemComponentEdit {
  const { provenance: _provenance, ...rest } = component;
  return rest;
}

/** Sets `aliasOf` from the first mode's value, so an alias written by hand is recorded. */
function withAlias(edit: DesignTokenEdit, baseModeId: string | undefined): DesignTokenEdit {
  const base =
    (baseModeId === undefined ? undefined : edit.values[baseModeId]) ??
    Object.values(edit.values)[0];
  const target = base === undefined ? null : aliasTarget(base);
  const { aliasOf: _previous, ...rest } = edit;
  return target === null || target === edit.name ? rest : { ...rest, aliasOf: target };
}

const findToken = (system: DesignSystem, name: string) =>
  system.tokens.find((token) => token.name === name);

/** The operations for one intent; empty when it would change nothing or names nothing. */
export function operationsFor(
  system: DesignSystem,
  intent: SystemEditIntent,
): DesignSystemOperation[] {
  const baseModeId = system.modes[0]?.id;
  switch (intent.kind) {
    case "set-value": {
      const token = findToken(system, intent.name);
      if (token === undefined) return [];
      const edit = tokenToEdit(token);
      const values = { ...edit.values };
      if (intent.raw === null) {
        if (intent.modeId === baseModeId || values[intent.modeId] === undefined) return [];
        delete values[intent.modeId];
      } else {
        const raw = intent.raw.trim();
        if (values[intent.modeId] === raw) return [];
        values[intent.modeId] = raw;
        // A first-mode value replaces the `default` an import without modes wrote.
        if (intent.modeId === baseModeId && intent.modeId !== "default") delete values.default;
      }
      return [{ op: "put_token", token: withAlias({ ...edit, values }, baseModeId) }];
    }
    case "rename": {
      const to = intent.to.trim();
      if (to === intent.from || findToken(system, intent.from) === undefined) return [];
      return [{ op: "rename_token", from: intent.from, to }];
    }
    case "remove":
      return findToken(system, intent.name) === undefined
        ? []
        : [{ op: "delete_token", name: intent.name }];
    case "set-usage": {
      const token = findToken(system, intent.name);
      if (token === undefined) return [];
      const text = intent.text.trim();
      if (text === (token.description ?? "")) return [];
      const { description: _old, ...edit } = tokenToEdit(token);
      return [{ op: "put_token", token: text === "" ? edit : { ...edit, description: text } }];
    }
    case "add":
    case "replace": {
      const token = { ...intent.token, name: intent.token.name.trim() };
      const values = Object.fromEntries(
        Object.entries(token.values)
          .map(([modeId, raw]) => [modeId, raw.trim()] as const)
          .filter(([, raw]) => raw !== ""),
      );
      const description = token.description?.trim();
      const { description: _description, ...rest } = token;
      return [
        {
          op: "put_token",
          token: withAlias(
            { ...rest, values, ...(description ? { description } : {}) },
            baseModeId,
          ),
        },
      ];
    }
    case "set-info": {
      const name = intent.name?.trim();
      const changesName = name !== undefined && name !== "" && name !== system.name;
      const description =
        intent.description === undefined
          ? undefined
          : intent.description === null || intent.description.trim() === ""
            ? null
            : intent.description.trim();
      const changesDescription =
        description !== undefined && (description ?? undefined) !== system.description;
      if (!changesName && !changesDescription) return [];
      return [
        {
          op: "set_info",
          ...(changesName ? { name } : {}),
          ...(changesDescription ? { description } : {}),
        },
      ];
    }
    case "put-mode": {
      const name = intent.name.trim();
      const current = system.modes.find((mode) => mode.id === intent.id);
      if (name === "" || current?.name === name) return [];
      return [{ op: "put_mode", mode: { id: intent.id, name } }];
    }
    case "delete-mode":
      return system.modes.length <= 1 || !system.modes.some((mode) => mode.id === intent.id)
        ? []
        : [{ op: "delete_mode", modeId: intent.id }];
    case "put-component":
      return [{ op: "put_component", component: intent.component }];
    case "remove-component":
      return system.components.some((component) => component.id === intent.id)
        ? [{ op: "delete_component", componentId: intent.id }]
        : [];
  }
}

/** Operations that put the system back as it was before `operations`, newest first. */
export function inverseOperations(
  system: DesignSystem,
  operations: readonly DesignSystemOperation[],
): DesignSystemOperation[] {
  const inverse: DesignSystemOperation[] = [];
  for (const operation of operations) {
    switch (operation.op) {
      case "put_token": {
        const before = findToken(system, operation.token.name);
        inverse.push(
          before === undefined
            ? { op: "delete_token", name: operation.token.name }
            : { op: "put_token", token: tokenToEdit(before) },
        );
        break;
      }
      case "rename_token":
        inverse.push({ op: "rename_token", from: operation.to, to: operation.from });
        break;
      case "delete_token": {
        const before = findToken(system, operation.name);
        if (before !== undefined) inverse.push({ op: "put_token", token: tokenToEdit(before) });
        break;
      }
      case "set_info":
        inverse.push({
          op: "set_info",
          ...(operation.name !== undefined ? { name: system.name } : {}),
          ...(operation.description !== undefined
            ? { description: system.description ?? null }
            : {}),
        });
        break;
      case "put_mode": {
        const before = system.modes.find((mode) => mode.id === operation.mode.id);
        inverse.push(
          before === undefined
            ? { op: "delete_mode", modeId: operation.mode.id }
            : { op: "put_mode", mode: { id: before.id, name: before.name } },
        );
        break;
      }
      case "delete_mode": {
        const before = system.modes.find((mode) => mode.id === operation.modeId);
        if (before === undefined) break;
        // Back comes the mode, then every value it held.
        const restore: DesignSystemOperation[] = [
          { op: "put_mode", mode: { id: before.id, name: before.name } },
          ...system.tokens
            .filter((token) => token.values[before.id] !== undefined)
            .map((token) => ({ op: "put_token" as const, token: tokenToEdit(token) })),
        ];
        // Pushed in reverse so the final reversal applies the mode first.
        inverse.push(...restore.toReversed());
        break;
      }
      case "put_component": {
        const before = system.components.find((item) => item.id === operation.component.id);
        inverse.push(
          before === undefined
            ? { op: "delete_component", componentId: operation.component.id }
            : { op: "put_component", component: componentToEdit(before) },
        );
        break;
      }
      case "delete_component": {
        const before = system.components.find((item) => item.id === operation.componentId);
        if (before !== undefined)
          inverse.push({ op: "put_component", component: componentToEdit(before) });
        break;
      }
    }
  }
  return inverse.toReversed();
}

/** The toast after an edit: "Changed color-brand", "Removed space-2". */
export function intentLabel(intent: SystemEditIntent): string {
  switch (intent.kind) {
    case "set-value":
      return intent.raw === null
        ? `${intent.name} now matches the first mode`
        : `Changed ${intent.name}`;
    case "rename":
      return `Renamed ${intent.from} to ${intent.to.trim()}`;
    case "remove":
      return `Removed ${intent.name}`;
    case "set-usage":
      return intent.text.trim() === ""
        ? `Removed the usage note of ${intent.name}`
        : `Saved the usage note of ${intent.name}`;
    case "add":
      return `Added ${intent.token.name.trim()}`;
    case "replace":
      return `Changed ${intent.token.name}`;
    case "set-info":
      return intent.name !== undefined ? "Renamed the design system" : "Saved the description";
    case "put-mode":
      return `Saved mode ${intent.name.trim()}`;
    case "delete-mode":
      return "Removed the mode";
    case "put-component":
      return `Saved ${intent.component.name}`;
    case "remove-component":
      return "Removed the component";
  }
}

/** A mode id from its name (`High contrast` → `high-contrast`), unique in the system. */
export function newModeId(name: string, existing: readonly string[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "mode";
  let id = base;
  for (let suffix = 2; existing.includes(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}

/** A component id from its name, unique in the system. */
export function newComponentId(name: string, existing: readonly string[]): string {
  const slug = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const base = `html:${slug || "component"}`;
  let id = base;
  for (let suffix = 2; existing.includes(id); suffix += 1) id = `${base}-${suffix}`;
  return id;
}
