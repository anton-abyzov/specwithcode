import type { ProviderInstanceEntry } from "../../providerInstances";

/** Over the list when the chosen provider can't run here: what the list offers instead. */
export function ModelPickerAlternativesNote(props: {
  readonly entry: ProviderInstanceEntry;
  readonly hasReady: boolean;
}) {
  return (
    <p
      className="shrink-0 border-b border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
      role="note"
      data-model-picker-alternatives={props.entry.instanceId}
    >
      <span className="text-foreground">
        {props.entry.displayName} can't run on this machine yet.
      </span>{" "}
      {props.hasReady ? "These models are ready now:" : "No other provider is ready here."}
    </p>
  );
}
