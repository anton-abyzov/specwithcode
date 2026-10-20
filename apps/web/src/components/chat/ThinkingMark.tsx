import type { ServerProvider } from "@specweave-studio/contracts";
import type { SVGProps } from "react";

import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

/**
 * Neutral thinking glyph, drawn in the EffortGlyph style: three dots fading
 * left to right. Shown when the thinking provider is unknown.
 */
export function ThinkingDotsGlyph({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
      data-thinking-dots-glyph=""
      {...props}
    >
      <circle cx="3" cy="8" r="1.75" />
      <circle cx="8" cy="8" r="1.75" opacity={0.6} />
      <circle cx="13" cy="8" r="1.75" opacity={0.3} />
    </svg>
  );
}

/**
 * A thinking row's mark: the provider that is thinking, muted, so the row
 * says who is thinking. `pulse` breathes while the thought is streaming;
 * reduced motion keeps it still (see `.thinking-mark-pulse`).
 */
export function ThinkingMark({
  provider,
  pulse = false,
  className,
}: {
  provider: Pick<ServerProvider, "driver" | "displayName" | "iconUrl"> | undefined;
  pulse?: boolean;
  className?: string;
}) {
  const pulseClassName = pulse ? "thinking-mark-pulse" : undefined;
  if (!provider) {
    return (
      <ThinkingDotsGlyph
        ref={pulse ? observeVisibleAnimation : undefined}
        className={cn(className, pulseClassName)}
        data-thinking-mark=""
        data-thinking-pulse={pulse ? "" : undefined}
      />
    );
  }
  return (
    <span
      ref={pulse ? observeVisibleAnimation : undefined}
      aria-hidden
      className={cn("inline-flex size-4 shrink-0 grayscale", className, pulseClassName)}
      data-thinking-mark={provider.driver}
      data-thinking-pulse={pulse ? "" : undefined}
    >
      <ProviderInstanceIcon
        driverKind={provider.driver}
        displayName={provider.displayName ?? provider.driver}
        acpRegistryIconUrl={provider.iconUrl}
        className="z-auto size-full"
        iconClassName="size-full"
      />
    </span>
  );
}
