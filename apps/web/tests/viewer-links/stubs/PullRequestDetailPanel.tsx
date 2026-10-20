/* Fixture pull request: the real panel reads the host; this shows what it was asked for. */
export function PullRequestDetailPanel(props: {
  readonly environmentId: string;
  readonly reference: { readonly repository: string; readonly number: number };
  readonly context?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-6" data-fixture-pr="true">
      <h3 className="font-semibold text-lg">
        Reset stale macOS permission entries for computer use #{props.reference.number}
      </h3>
      <p className="text-muted-foreground text-sm">
        {props.reference.repository} · read on {props.environmentId} · {props.context}
      </p>
      <button type="button" className="self-start rounded border px-2 py-1 text-sm">
        Merge
      </button>
    </div>
  );
}
