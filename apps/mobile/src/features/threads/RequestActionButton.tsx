import type { ComponentProps } from "react";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

/** Primary actions in the cards that replace the thread composer. */
export function RequestActionButton({
  label,
  tone = "primary",
  size = "default",
  disabled,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style"> & {
  label: string;
  /** `quiet` is a text-only action, such as Cancel under a stack of buttons. */
  tone?: "primary" | "secondary" | "danger" | "quiet";
  size?: "default" | "large";
}) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ ...props.accessibilityState, disabled: Boolean(disabled) }}
      disabled={disabled}
      className={cn(
        "items-center justify-center active:opacity-70 disabled:opacity-50",
        size === "large" ? "rounded-2xl px-4 py-3.5" : "rounded-[14px] px-3.5 py-3",
        tone === "primary"
          ? "bg-primary"
          : tone === "danger"
            ? "bg-danger"
            : tone === "quiet"
              ? "bg-transparent"
              : "bg-subtle-strong",
      )}
    >
      <Text
        className={cn(
          "text-sm",
          tone === "primary"
            ? "font-studio-extrabold text-primary-foreground"
            : tone === "danger"
              ? "font-studio-bold text-danger-foreground"
              : tone === "quiet"
                ? "font-studio-semibold text-foreground-secondary"
                : "font-studio-bold text-foreground",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
}
