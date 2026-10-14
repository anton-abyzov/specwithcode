import type { ProviderAuthResponse } from "@specweave-studio/contracts";
// Simulate the terminal surface only; responses still traverse the production parent's queue.
export default function Terminal({
  output,
  onResponse,
}: {
  output: string;
  onResponse: (response: Extract<ProviderAuthResponse, { type: "terminal" }>) => void;
}) {
  return (
    <div
      aria-label="Fixture sign-in terminal"
      className="rounded-md border border-border p-3 text-xs"
    >
      <pre className="whitespace-pre-wrap">{output}</pre>
      <button type="button" onClick={() => onResponse({ type: "terminal", data: "y\r" })}>
        Confirm credential storage
      </button>
    </div>
  );
}
