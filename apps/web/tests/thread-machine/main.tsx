import { RelayedMessage } from "../../src/components/studio/RelayedMessage";
import { MOBILE_CARRY_FORWARD, MOBILE_USER_RESULTS } from "../agent-messages/internalReceipts";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDownIcon, ShieldIcon } from "lucide-react";

import {
  ComposerControl,
  ComposerControlSeparator,
} from "../../src/components/chat/ComposerControl";
import { ThreadMachineComposerChip } from "../../src/components/chat/ThreadMachineComposerChip";
import { ThreadMetaRow } from "../../src/components/chat/ThreadMetaRow";
import { threadMachinePresentation } from "../../src/components/chat/threadMachine";
import "./fixture.css";

// Real chip, meta row and presentation; the provider controls are stand-ins.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const unreachable = params.has("unreachable");
const machine = threadMachinePresentation({
  name: "linuxbox",
  hostLabel: "linuxbox",
  kind: "laptop",
  os: "linux",
  isThisMachine: false,
  phase: unreachable ? "reconnecting" : "connected",
  error: unreachable ? "timed out" : null,
  canOperate: true,
  handoff: "available",
});

function Fixture() {
  const [scenario, setScenario] = useState("settled");
  const timing = params.has("timing");
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset * 60000).toISOString();
  const previous = { id: "first", status: "completed", startedAt: iso(-60), completedAt: iso(-55) };
  const latest = {
    id: "latest",
    status:
      scenario === "queued"
        ? "queued"
        : scenario === "missing"
          ? "failed"
          : scenario === "settled" || scenario === "watch"
            ? "completed"
            : "running",
    startedAt: scenario === "queued" ? null : iso(-2),
    completedAt: scenario === "settled" || scenario === "watch" ? iso(-1) : null,
  };

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 items-center gap-2 px-4 text-sm text-muted-foreground">
        No project <span>/</span> <span className="text-foreground">Current Time</span>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-2">
        {timing && (
          <div className="flex flex-wrap gap-2">
            {["settled", "live", "wait", "queued", "watch", "missing"].map((value) => (
              <button key={value} className="rounded border p-2" onClick={() => setScenario(value)}>
                {value}
              </button>
            ))}
          </div>
        )}
        <ThreadMetaRow
          machine={machine}
          origin={null}
          folder={{
            label: "2026-10-26-time-now-44ce7",
            path: "/home/dev/chats/2026-10-26-time-now-44ce7",
          }}
          run={
            timing
              ? latest
              : { startedAt: "2026-10-26T22:40:00.000Z", completedAt: "2026-10-26T22:40:30.000Z" }
          }
          recordedRuns={timing ? [previous, latest] : undefined}
          historyComplete={timing}
          runHealth={
            scenario === "wait"
              ? { state: "waiting", label: "Waiting for a tool", idleMs: 0, waitingMs: 0 }
              : null
          }
          background={
            scenario === "watch"
              ? { label: "Watching pull request checks", waiting: true, kind: "monitor" }
              : null
          }
          pullRequests={[]}
          onOpenPullRequest={() => {}}
        />
        {params.has("mobile") && (
          <section>
            {(["coordinator", "thread"] as const).map((source) => (
              <RelayedMessage
                key={source}
                detail="concise"
                source={source}
                label={`Message from ${source}`}
                view={{ label: "View source", onOpen: () => {} }}
                createdAt="2026-10-28T16:45:40Z"
                timestampFormat="12-hour"
                original={MOBILE_CARRY_FORWARD}
                text={MOBILE_CARRY_FORWARD}
                renderMarkdown={(text) => <p>{text}</p>}
              />
            ))}
            {MOBILE_USER_RESULTS.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </section>
        )}
        <div className="self-end rounded-2xl bg-secondary px-3 py-2 text-sm">
          What is the name of the machine you are running on?
        </div>
        <div className="text-sm">
          The machine's hostname is <code>linuxbox</code>.
        </div>
        <div className="flex-1" />
        <div className="@container/composer-surface mb-4 rounded-2xl border bg-card">
          <div className="px-4 pt-3 pb-8 text-sm text-muted-foreground">
            Ask anything, @tag files/folders, $use skills, or / for commands
          </div>
          <div className="flex items-center gap-1 px-3 pb-3">
            <ThreadMachineComposerChip machine={machine} size="sm" />
            <ComposerControl>
              Claude Code · Opus 5.5 <ChevronDownIcon className="size-3" />
            </ComposerControl>
            <ComposerControlSeparator />
            <ComposerControl>
              Medium 1M · Thinking <ChevronDownIcon className="size-3" />
            </ComposerControl>
            <ComposerControlSeparator />
            <ComposerControl>
              <ShieldIcon /> Full access <ChevronDownIcon className="size-3" />
            </ComposerControl>
          </div>
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
