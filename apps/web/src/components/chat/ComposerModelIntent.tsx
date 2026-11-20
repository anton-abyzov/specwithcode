/** Uses the composer's resolved chip state, never the raw persisted draft. */
export function ComposerModelIntent({
  state,
  routed,
}: {
  state: "thread" | "next" | "pick";
  routed: boolean;
}) {
  if (routed || state !== "pick") return null;
  return (
    <p
      role="status"
      data-composer-model-intent="pending"
      className="px-3 pt-2 text-xs text-muted-foreground"
    >
      Composer selection differs from the thread model.
    </p>
  );
}
