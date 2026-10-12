"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { useId, useState } from "react";
import type * as React from "react";

import { cn } from "~/lib/utils";

type InputProps = Omit<InputPrimitive.Props & React.RefAttributes<HTMLInputElement>, "size"> & {
  size?: "sm" | "compact" | "default" | "lg" | number;
  /** Monospace with tabular digits, for paths, commands, colors and numbers. */
  font?: "default" | "mono";
  unstyled?: boolean;
  nativeInput?: boolean;
  /** Show "used / max" at the end of the field. Needs `maxLength`. */
  showCount?: boolean;
};

const countFormat = new Intl.NumberFormat();

function Input({
  className,
  size = "default",
  font = "default",
  unstyled = false,
  nativeInput = false,
  showCount = false,
  ...props
}: InputProps) {
  const countMax = showCount && typeof props.maxLength === "number" ? props.maxLength : null;
  const [uncontrolledLength, setUncontrolledLength] = useState(() =>
    typeof props.defaultValue === "string" ? props.defaultValue.length : 0,
  );
  const countId = useId();
  const countLength = typeof props.value === "string" ? props.value.length : uncontrolledLength;
  type ChangeEvent = Parameters<NonNullable<typeof props.onChange>>[0];
  // The count is the field's description, so it never joins an enclosing
  // label's name. An uncontrolled field has no value to read, so the count
  // follows its edits.
  const fieldProps: typeof props =
    countMax === null
      ? props
      : {
          ...props,
          "aria-describedby": cn(props["aria-describedby"], countId),
          ...(typeof props.value !== "string" && {
            onChange: (event: ChangeEvent) => {
              setUncontrolledLength(event.currentTarget.value.length);
              props.onChange?.(event);
            },
          }),
        };
  const inputClassName = cn(
    "h-8.5 w-full min-w-0 rounded-[inherit] px-[calc(--spacing(3)-1px)] leading-8.5 outline-none placeholder:text-placeholder sm:h-7.5 sm:leading-7.5 [transition:background-color_5000000s_ease-in-out_0s]",
    size === "compact" && "h-7 px-[calc(--spacing(2.5)-1px)] text-xs leading-7 sm:h-7 sm:leading-7",
    size === "sm" && "h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5",
    size === "lg" && "h-9.5 leading-9.5 sm:h-8.5 sm:leading-8.5",
    props.type === "search" &&
      "[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none [&::-webkit-search-results-button]:appearance-none [&::-webkit-search-results-decoration]:appearance-none",
    // Number fields are typed into; browser spin buttons crowd narrow fields and step by 1.
    props.type === "number" &&
      "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
    props.type === "file" &&
      "text-muted-foreground file:me-3 file:bg-transparent file:font-medium file:text-foreground file:text-sm",
    countMax !== null && (countMax >= 10_000 ? "pe-28" : countMax >= 1000 ? "pe-24" : "pe-16"),
  );
  let inputElement: React.ReactElement;

  if (nativeInput) {
    const { style, onValueChange: _onValueChange, ...nativeInputProps } = fieldProps;
    const nativeStyle = typeof style === "function" ? undefined : style;

    inputElement = (
      <input
        className={inputClassName}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        style={nativeStyle}
        {...(nativeInputProps as React.ComponentProps<"input">)}
      />
    );
  } else {
    inputElement = (
      <InputPrimitive
        className={inputClassName}
        data-slot="input"
        size={typeof size === "number" ? size : undefined}
        {...fieldProps}
      />
    );
  }

  return (
    <span
      className={
        cn(
          !unstyled &&
            "relative inline-flex w-full rounded-lg border border-input bg-background not-dark:bg-clip-padding text-base text-foreground shadow-xs/5 ring-ring/24 transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_1px_--theme(--color-black/4%)] has-focus-visible:has-aria-invalid:border-destructive/64 has-focus-visible:has-aria-invalid:ring-destructive/16 has-aria-invalid:border-destructive/36 has-focus-visible:border-ring has-autofill:bg-foreground/4 has-disabled:opacity-64 has-[:disabled,:focus-visible,[aria-invalid]]:shadow-none has-focus-visible:ring-[3px] sm:text-sm dark:bg-input/32 dark:has-autofill:bg-foreground/8 dark:has-aria-invalid:ring-destructive/24 dark:not-has-disabled:not-has-focus-visible:not-has-aria-invalid:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          !unstyled &&
            size === "compact" &&
            "rounded-md before:rounded-[calc(var(--radius-md)-1px)]",
          font === "mono" && "font-mono tabular-nums",
          countMax !== null && "relative",
          className,
        ) || undefined
      }
      data-size={size}
      data-slot="input-control"
    >
      {inputElement}
      {countMax !== null ? (
        <span
          id={countId}
          aria-hidden
          data-slot="character-count"
          className={cn(
            "pointer-events-none absolute inset-y-0 end-2 flex items-center text-[11px] text-muted-foreground tabular-nums",
            countLength >= countMax * 0.9 && "text-warning-foreground",
            countLength > countMax && "text-destructive-foreground",
          )}
        >
          <span className="sr-only">Characters used: </span>
          {countFormat.format(countLength)} / {countFormat.format(countMax)}
        </span>
      ) : null}
    </span>
  );
}

export { Input, type InputProps };
