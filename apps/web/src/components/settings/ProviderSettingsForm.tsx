"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  REDACTED_SECRET_MARKER,
  type ProviderSettingsFormAnnotation,
  type ProviderSettingsFormControl,
  type ProviderSettingsFormOption,
  type ProviderSettingsFormSchemaAnnotation,
} from "@specweave-studio/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { ProviderClientDefinition } from "./providerDriverMeta";
import { SettingsRow } from "./settingsLayout";

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  readonly defaultBooleanValue?: boolean | undefined;
  /** Choices for a `select` control. The first entry is the default. */
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
  key: "title" | "description",
): string | undefined {
  const annotations = readFieldAnnotations(fieldSchema);
  const value = annotations?.[key];
  return typeof value === "string" ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): ProviderSettingsFormAnnotation {
  const annotation = readFieldAnnotations(fieldSchema)?.providerSettingsForm;
  return annotation ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: ProviderClientDefinition,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldBooleanDefault(
  fieldSchema: ProviderClientDefinition["settingsSchema"]["fields"][string],
): boolean | undefined {
  const decodeDefault = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>);
  const decoded = decodeDefault(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "boolean" ? decoded.value : undefined;
}

export function deriveProviderSettingsFields(
  definition: ProviderClientDefinition,
  value?: unknown,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const isLocalAcp =
    definition.value === "acpRegistry" && readProviderConfigString(value, "source") === "local";
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted((left, right) => {
      return (
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index)
      );
    })
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];
      if (isLocalAcp && key !== "source" && key !== "commandPath") return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label:
            isLocalAcp && key === "commandPath"
              ? "Executable"
              : (annotatedTitle ?? titleizeFieldKey(key)),
          ...(isLocalAcp && key === "commandPath"
            ? { description: "Executable name or path on this environment." }
            : annotatedDescription !== undefined
              ? { description: annotatedDescription }
              : {}),
          ...(isLocalAcp && key === "commandPath"
            ? { placeholder: "e.g. dsh" }
            : formAnnotation.placeholder !== undefined
              ? { placeholder: formAnnotation.placeholder }
              : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          ...(formAnnotation.control === "select" && formAnnotation.options
            ? { options: formAnnotation.options }
            : {}),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

let commandArgumentDraftId = 0;
const makeCommandArgumentDraftRow = (value: string) => ({
  id: `provider-argument-${commandArgumentDraftId++}`,
  value,
});

function commandArgumentsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function ProviderCommandArguments({
  value,
  onChange,
}: Pick<ProviderSettingsFormProps, "value" | "onChange">) {
  const args = useMemo(() => {
    const configured =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>).commandArgs
        : undefined;
    return Array.isArray(configured)
      ? configured.filter((argument): argument is string => typeof argument === "string")
      : [];
  }, [value]);
  const [rows, setRows] = useState(() => args.map(makeCommandArgumentDraftRow));
  const rowsRef = useRef(rows);
  const previousArgsRef = useRef(args);
  const lastPublishedArgsRef = useRef<ReadonlyArray<string> | undefined>(undefined);

  useEffect(() => {
    const previousArgs = previousArgsRef.current;
    const lastPublishedArgs = lastPublishedArgsRef.current;
    previousArgsRef.current = args;
    lastPublishedArgsRef.current = undefined;
    if (
      commandArgumentsEqual(previousArgs, args) ||
      (lastPublishedArgs !== undefined && commandArgumentsEqual(lastPublishedArgs, args))
    )
      return;
    const nextRows = args.map(makeCommandArgumentDraftRow);
    rowsRef.current = nextRows;
    setRows(nextRows);
  }, [args]);

  const updateArguments = (nextRows: typeof rows) => {
    rowsRef.current = nextRows;
    setRows(nextRows);
    const next = nextRows.map((row) => row.value);
    lastPublishedArgsRef.current = next;
    const config =
      value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
    onChange({ ...config, commandArgs: next });
  };

  return (
    <SettingsRow
      title="Arguments"
      description="One literal argument per row, in launch order."
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => updateArguments([...rowsRef.current, makeCommandArgumentDraftRow("")])}
        >
          <PlusIcon />
          Add argument
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((argument, index) => (
            <div key={argument.id} className="flex min-w-0 items-center gap-1.5">
              <DraftInput
                size="sm"
                font="mono"
                value={argument.value}
                onCommit={(next) =>
                  updateArguments(
                    rowsRef.current.map((current) =>
                      current.id === argument.id ? { ...current, value: next } : current,
                    ),
                  )
                }
                aria-label={`Argument ${index + 1}`}
                spellCheck={false}
              />
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() =>
                  updateArguments(rowsRef.current.filter((current) => current.id !== argument.id))
                }
                aria-label={`Remove argument ${index + 1}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}

function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function readProviderConfigBoolean(config: unknown, key: string, defaultValue = false): boolean {
  if (config === null || typeof config !== "object") return defaultValue;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "boolean") {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  const trimmed = value.trim();
  if (field.clearWhenEmpty === "omit" && trimmed.length === 0) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

interface ProviderSettingsFormProps {
  readonly definition: ProviderClientDefinition;
  readonly value: unknown;
  readonly idPrefix: string;
  /**
   * `card` stacks label over control, `dialog` is the compact wizard layout,
   * and `settings` renders the shared settings row treatment.
   */
  readonly variant: "card" | "dialog" | "settings";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

/** Stores the default choice as an omitted key so unchanged configs stay small. */
function ProviderSettingsSelect({
  field,
  value,
  inputId,
  size,
  className,
  onChange,
}: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly inputId: string;
  readonly size: "sm" | "xs";
  readonly className?: string | undefined;
  readonly onChange: ProviderSettingsFormProps["onChange"];
}) {
  const options = field.options ?? [];
  const fallback = options[0]?.value ?? "";
  const current = readProviderConfigString(value, field.key) || fallback;
  const label = options.find((option) => option.value === current)?.label ?? current;
  return (
    <Select
      value={current}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onChange(nextProviderConfigWithFieldValue(value, field, next === fallback ? "" : next));
      }}
    >
      <SelectTrigger id={inputId} size={size} className={className} aria-label={field.label}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div>{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

/** Origin of an address, or its trimmed text when it does not parse (as the server compares). */
function addressOrigin(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

/** Where a provider password is sent: the origins of the config's address fields. */
function providerSecretDestination(config: unknown): string {
  if (config === null || typeof config !== "object") return "";
  return Object.entries(config as Record<string, unknown>)
    .flatMap(([key, field]) =>
      /(url|endpoint)$/i.test(key) && typeof field === "string"
        ? [`${key}=${addressOrigin(field)}`]
        : [],
    )
    .toSorted()
    .join("\n");
}

/**
 * True once a saved password disappears while its address field moved to
 * another origin: the server drops it then rather than send it to the new
 * server. The second value forgets the saved state, for a deliberate clear.
 */
function useSecretClearedByAddressChange(
  isPassword: boolean,
  rawText: string,
  config: unknown,
): readonly [boolean, () => void] {
  // Destination the saved password was first seen with; kept while the
  // marker stays, so an edited address before the save still counts.
  const savedForRef = useRef<string | undefined>(undefined);
  const [cleared, setCleared] = useState(false);
  useEffect(() => {
    if (!isPassword) return;
    if (rawText === REDACTED_SECRET_MARKER) {
      savedForRef.current ??= providerSecretDestination(config);
      setCleared(false);
      return;
    }
    const savedFor = savedForRef.current;
    savedForRef.current = undefined;
    setCleared(
      rawText.length === 0 &&
        savedFor !== undefined &&
        savedFor !== providerSecretDestination(config),
    );
  }, [isPassword, rawText, config]);
  const forget = () => {
    savedForRef.current = undefined;
    setCleared(false);
  };
  return [cleared, forget] as const;
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "dialog"
      ? "text-2xs text-muted-foreground"
      : "mt-1 block text-xs text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  // The server sends a marker instead of a saved password; echoing the
  // marker back keeps it, so the input stays empty until a new value is typed.
  const rawText = readProviderConfigString(value, field.key);
  const hasStoredSecret = field.control === "password" && rawText === REDACTED_SECRET_MARKER;
  const [clearedByAddressChange, forgetStoredSecret] = useSecretClearedByAddressChange(
    field.control === "password",
    rawText,
    value,
  );
  const clearedNote = clearedByAddressChange
    ? `${field.label} cleared because the server address changed. Enter it again to use it there.`
    : undefined;
  const descriptionText =
    field.description || clearedNote ? (
      <>
        {field.description}
        {clearedNote ? (
          <span className="block text-warning-foreground" role="status">
            {clearedNote}
          </span>
        ) : null}
      </>
    ) : null;
  const description = descriptionText ? (
    <span className={descriptionClassName}>{descriptionText}</span>
  ) : null;
  const textValue = hasStoredSecret ? "" : rawText;
  const textPlaceholder = hasStoredSecret
    ? "Stored secret - enter a new value to replace"
    : field.placeholder;
  const clearStoredSecret = hasStoredSecret ? (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost-destructive"
      onClick={() => {
        forgetStoredSecret();
        onChange(nextProviderConfigWithFieldValue(value, field, ""));
      }}
      aria-label={`Clear ${field.label}`}
    >
      <XIcon className="size-3.5" />
    </Button>
  ) : null;

  if (variant === "settings") {
    const descriptionId = descriptionText ? `${inputId}-description` : undefined;
    const control =
      field.control === "switch" ? (
        <Switch
          checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
          onCheckedChange={(checked) =>
            onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
          }
          aria-label={field.label}
          aria-describedby={descriptionId}
        />
      ) : field.control === "select" ? (
        <ProviderSettingsSelect
          field={field}
          value={value}
          inputId={inputId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          onChange={onChange}
        />
      ) : field.control === "textarea" ? (
        <Textarea
          id={inputId}
          aria-describedby={descriptionId}
          className="w-full max-w-full @min-[32rem]/settings-row:w-[min(24rem,50cqw)]"
          value={readProviderConfigString(value, field.key)}
          onChange={(event) =>
            onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
          }
          placeholder={field.placeholder}
          spellCheck={false}
        />
      ) : hasStoredSecret ? (
        <div className="flex w-full min-w-0 items-center gap-2 @min-[32rem]/settings-row:w-56">
          <DraftInput
            id={inputId}
            aria-describedby={descriptionId}
            size="sm"
            className="min-w-0 flex-1"
            type="password"
            autoComplete="off"
            value={textValue}
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            placeholder={textPlaceholder}
            spellCheck={false}
          />
          {clearStoredSecret}
        </div>
      ) : (
        <DraftInput
          id={inputId}
          aria-describedby={descriptionId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          type={field.control === "password" ? "password" : undefined}
          autoComplete={field.control === "password" ? "off" : undefined}
          value={textValue}
          onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
          placeholder={textPlaceholder}
          spellCheck={false}
        />
      );

    return (
      <SettingsRow
        title={
          field.control === "switch" ? field.label : <label htmlFor={inputId}>{field.label}</label>
        }
        description={
          descriptionText ? <span id={descriptionId}>{descriptionText}</span> : undefined
        }
        control={control}
      />
    );
  }

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "select") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <ProviderSettingsSelect
            field={field}
            value={value}
            inputId={inputId}
            size="sm"
            className={cn("w-full", variant === "card" && "mt-1.5")}
            onChange={onChange}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <Textarea
            id={inputId}
            className={cn(variant === "card" && "mt-1.5")}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {variant === "card" ? (
          <div className="mt-1.5 flex min-w-0 items-center gap-2">
            <DraftInput
              id={inputId}
              size="sm"
              className="min-w-0 flex-1"
              type={type}
              autoComplete={field.control === "password" ? "off" : undefined}
              value={textValue}
              onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
              placeholder={textPlaceholder}
              spellCheck={false}
            />
            {clearStoredSecret}
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <Input
              id={inputId}
              className="min-w-0 flex-1"
              type={type}
              autoComplete={field.control === "password" ? "off" : undefined}
              value={textValue}
              onChange={(event) =>
                onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
              }
              placeholder={textPlaceholder}
              spellCheck={false}
            />
            {clearStoredSecret}
          </div>
        )}
        {description}
      </label>
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(
    () => deriveProviderSettingsFields(definition, value),
    [definition, value],
  );
  const isLocalAcp =
    definition.value === "acpRegistry" && readProviderConfigString(value, "source") === "local";

  if (fields.length === 0) {
    return null;
  }

  return (
    <>
      {fields.map((field) => (
        <ProviderSettingsFieldRow
          key={field.key}
          field={field}
          value={value}
          idPrefix={idPrefix}
          variant={variant}
          onChange={onChange}
        />
      ))}
      {isLocalAcp ? <ProviderCommandArguments value={value} onChange={onChange} /> : null}
    </>
  );
}
