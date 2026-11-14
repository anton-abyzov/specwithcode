import { useEffect, useState } from "react";
import { CopyPhaseTrack, CopyProgressPanel } from "../../src/components/studio/CopyProgressPanel";
import type { CopyProgressView } from "../../src/studio/copyProgress";

// `?progress=1`: the copy progress states with live numbers, for screenshots. The send
// panel moves 40 MB a second, so its speed and time left appear after a few seconds.
const GB = 1_000_000_000;
const TOTAL = 7.5 * GB;
const FILES = 121_868;

const measuring: CopyProgressView = {
  phase: "measure",
  step: "Reading the selected files on m4",
  fraction: 0.62,
  bytes: { done: 4.65 * GB, total: TOTAL },
  files: { done: 75_558, total: FILES },
  bytesLocal: 0,
  rateKey: null,
  outcome: "running",
};
const done: CopyProgressView = {
  phase: "apply",
  step: "Copied to m5",
  fraction: 1,
  bytes: { done: TOTAL, total: TOTAL },
  files: { done: FILES, total: FILES },
  bytesLocal: 0,
  rateKey: null,
  outcome: "finished",
};
const failed: CopyProgressView = {
  phase: "send",
  step: "Stopped while sending to m5",
  fraction: 0.41,
  bytes: { done: 3.07 * GB, total: TOTAL },
  files: { done: 49_966, total: FILES },
  bytesLocal: 0,
  rateKey: null,
  outcome: "failed",
};

function useSending(): CopyProgressView {
  const [sent, setSent] = useState(2.1 * GB);
  useEffect(() => {
    const timer = window.setInterval(() => setSent((value) => value + 40_000_000), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return {
    phase: "send",
    step: "Sending files to m5",
    fraction: sent / TOTAL,
    bytes: { done: sent, total: TOTAL },
    files: { done: Math.round((sent / TOTAL) * FILES), total: FILES },
    bytesLocal: 0,
    rateKey: "send",
    outcome: "running",
  };
}

export function ProgressGallery() {
  const sending = useSending();
  const panel = (title: string, view: CopyProgressView) => (
    <figure className="space-y-2" data-slot="progress-case">
      <figcaption className="text-xs text-muted-foreground">{title}</figcaption>
      <CopyProgressPanel view={view} sourceLabel="m4" targetLabel="m5" />
    </figure>
  );
  return (
    <main className="mx-auto grid max-w-[1080px] gap-8 bg-background p-8 text-foreground md:grid-cols-2">
      {panel("Measure on the source", measuring)}
      {panel("Send, with speed and time left", sending)}
      {panel("Done", done)}
      {panel("Stopped", failed)}
      <figure className="space-y-2 md:col-span-2" data-slot="progress-case">
        <figcaption className="text-xs text-muted-foreground">Banner and sidebar track</figcaption>
        <div className="rounded-lg border bg-muted/40 px-4 py-2">
          <CopyPhaseTrack view={sending} sourceLabel="m4" targetLabel="m5" compact />
        </div>
      </figure>
    </main>
  );
}
