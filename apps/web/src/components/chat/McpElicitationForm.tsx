import type {
  OrchestrationV2McpElicitation,
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  RuntimeRequestId,
} from "@specweave-studio/contracts";
import {
  mcpElicitationInitialValues,
  parseMcpElicitationSchema,
  validateMcpElicitationContent,
  type McpElicitationField,
} from "@specweave-studio/shared/mcpElicitationForm";
import { memo, useId, useMemo, useState } from "react";

import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { cn } from "~/lib/utils";
import { OnActionMachine, type ActionMachine } from "../../studio/actionMachine";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";

export interface McpElicitationFormProps {
  requestId: RuntimeRequestId;
  elicitation: OrchestrationV2McpElicitation;
  pendingCount: number;
  disabled: boolean;
  isResponding: boolean;
  machine?: ActionMachine | null | undefined;
  onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    content?: ProviderUserInputAnswers,
  ) => Promise<unknown>;
}

type Values = Record<string, unknown>;

const INPUT_TYPE: Record<string, string> = {
  email: "email",
  uri: "url",
  date: "date",
  "date-time": "datetime-local",
};

// "sm" buttons match the approval and question actions; below 420px they stack.
const BUTTON_CLASS = "min-w-20 max-w-full @max-[420px]:w-full";

/** An MCP server's form, filled in and sent by the person (1481). */
export const McpElicitationForm = memo(function McpElicitationForm({
  requestId,
  elicitation,
  pendingCount,
  disabled,
  isResponding,
  machine,
  onRespond,
}: McpElicitationFormProps) {
  const tx = useTx();
  const formId = useId();
  const form = useMemo(
    () => parseMcpElicitationSchema(elicitation.requestedSchema),
    [elicitation.requestedSchema],
  );
  const fields = form.ok ? form.fields : [];
  const [values, setValues] = useState<Values>(() => mcpElicitationInitialValues(fields));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const locked = disabled || isResponding;
  const set = (key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!(key in current)) return current;
      const { [key]: _cleared, ...rest } = current;
      return rest;
    });
  };
  const submit = () => {
    if (locked || !form.ok) return;
    const checked = validateMcpElicitationContent(fields, values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    void onRespond(requestId, "accept", checked.content as ProviderUserInputAnswers);
  };

  const renderField = (field: McpElicitationField) => {
    const id = `${formId}-${field.key}`;
    const error = errors[field.key];
    const describedBy = [
      field.description ? `${id}-description` : null,
      error ? `${id}-error` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const label = (
      <span className="flex min-w-0 items-baseline gap-1 text-xs font-medium text-foreground">
        <span className="min-w-0 wrap-break-word">{field.title}</span>
        {field.required ? (
          <span aria-hidden="true" className="text-warning-foreground">
            *
          </span>
        ) : null}
      </span>
    );
    const help = (
      <>
        {field.description ? (
          <span id={`${id}-description`} className="text-2xs text-muted-foreground">
            {field.description}
          </span>
        ) : null}
        {error ? (
          <span id={`${id}-error`} role="alert" className="text-2xs text-destructive-foreground">
            {tx(error)}
          </span>
        ) : null}
      </>
    );
    if (field.kind === "boolean") {
      return (
        <div key={field.key} className="flex flex-col gap-1" data-elicitation-field={field.key}>
          <label htmlFor={id} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={values[field.key] === true}
              disabled={locked}
              aria-describedby={describedBy || undefined}
              onCheckedChange={(checked) => set(field.key, checked === true)}
            />
            {label}
          </label>
          {help}
        </div>
      );
    }
    if (field.kind === "select" || field.kind === "multiselect") {
      const selected =
        field.kind === "select"
          ? new Set(typeof values[field.key] === "string" ? [values[field.key] as string] : [])
          : new Set(Array.isArray(values[field.key]) ? (values[field.key] as string[]) : []);
      return (
        <div
          key={field.key}
          role="group"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy || undefined}
          className="flex flex-col gap-1"
          data-elicitation-field={field.key}
        >
          <span id={`${id}-label`}>{label}</span>
          <div className="flex flex-wrap gap-1.5">
            {field.options.map((option) => {
              const pressed = selected.has(option.value);
              return (
                <Button
                  key={option.value}
                  type="button"
                  size="sm"
                  variant={pressed ? "default" : "outline"}
                  aria-pressed={pressed}
                  disabled={locked}
                  data-elicitation-option={option.value}
                  onClick={() => {
                    if (field.kind === "select") {
                      set(field.key, pressed && !field.required ? undefined : option.value);
                      return;
                    }
                    const next = new Set(selected);
                    if (pressed) next.delete(option.value);
                    else next.add(option.value);
                    set(
                      field.key,
                      field.options.map((entry) => entry.value).filter((value) => next.has(value)),
                    );
                  }}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                </Button>
              );
            })}
          </div>
          {help}
        </div>
      );
    }
    const raw = values[field.key];
    return (
      <div key={field.key} className="flex flex-col gap-1" data-elicitation-field={field.key}>
        <label htmlFor={id}>{label}</label>
        <Input
          id={id}
          size="sm"
          type={
            field.kind === "number"
              ? "number"
              : field.format === undefined
                ? "text"
                : (INPUT_TYPE[field.format] ?? "text")
          }
          {...(field.kind === "number"
            ? {
                inputMode: field.integer ? ("numeric" as const) : ("decimal" as const),
                step: field.integer ? 1 : "any",
                ...(field.minimum === undefined ? {} : { min: field.minimum }),
                ...(field.maximum === undefined ? {} : { max: field.maximum }),
              }
            : {
                ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
              })}
          value={raw === undefined || raw === null ? "" : String(raw)}
          disabled={locked}
          required={field.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set(field.key, event.currentTarget.value)}
        />
        {help}
      </div>
    );
  };

  // A div, not a form: the card sits inside the composer's form, and a nested
  // form's submit would also reach the composer. Enter in a field submits here.
  return (
    <div
      role="form"
      aria-label={tx("{server} asks for input", { server: elicitation.serverName })}
      className="flex min-w-0 flex-1 flex-col items-stretch gap-2.5"
      data-mcp-elicitation-form=""
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        if (!(event.target instanceof HTMLInputElement)) return;
        if (event.target.type === "checkbox") return;
        event.preventDefault();
        event.stopPropagation();
        submit();
      }}
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate font-medium text-warning-foreground">
          {tx("{server} asks for input", { server: elicitation.serverName })}
        </span>
        <OnActionMachine machine={machine} />
        {pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">
            {renderRich(tx("1 of {pendingCount}"), { pendingCount })}
          </span>
        ) : null}
      </span>
      <span className="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
        {elicitation.message}
      </span>
      {form.ok ? (
        fields.length > 0 ? (
          <div className="flex flex-col gap-2.5">{fields.map(renderField)}</div>
        ) : null
      ) : (
        <span className="text-xs text-muted-foreground" role="status">
          {tx("This form can't be shown. Decline or cancel it.")}
        </span>
      )}
      <span className="text-2xs text-muted-foreground">
        {tx("What you submit goes to {server}. Never enter a password or secret here.", {
          server: elicitation.serverName,
        })}
      </span>
      <div
        data-approval-actions=""
        className="flex w-full min-w-0 flex-wrap-reverse items-center gap-2 @max-[420px]:flex-col-reverse @max-[420px]:flex-nowrap @max-[420px]:items-stretch"
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={cn(BUTTON_CLASS, "me-auto @max-[420px]:me-0")}
          data-approval-decision="cancel"
          disabled={locked}
          onClick={() => {
            if (!locked) void onRespond(requestId, "cancel");
          }}
        >
          {tx("Cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={BUTTON_CLASS}
          data-approval-decision="decline"
          disabled={locked}
          onClick={() => {
            if (!locked) void onRespond(requestId, "decline");
          }}
        >
          {tx("Decline")}
        </Button>
        <Button
          type="button"
          size="sm"
          className={BUTTON_CLASS}
          data-approval-decision="accept"
          disabled={locked || !form.ok}
          onClick={submit}
        >
          {tx("Submit")}
        </Button>
      </div>
    </div>
  );
});
