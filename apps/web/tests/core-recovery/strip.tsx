import { presentPendingBackgroundWork } from "@specweave-studio/client-runtime/state/thread-execution";
import { derivePendingBackgroundWork } from "@specweave-studio/shared/orchestrationV2PendingBackgroundWork";
import {
  BackgroundWorkIcon,
  BackgroundWorkLabel,
  BackgroundWorkStopButton,
} from "../../src/components/chat/BackgroundWorkStrip";
import { ComposerBanner } from "../../src/components/chat/ComposerBanner";
import { ComposerSurface } from "../../src/components/chat/ComposerSurface";
import {
  ComposerBannerStack,
  type ComposerBannerStackItem,
} from "../../src/components/chat/ComposerBannerStack";

// The composer's background-work strip ("3 subagents") over the real pending-work
// derivation, before and after 1048 settles stranded native subagents (AC-04).
type Subagent = { readonly id: string; readonly title: string; readonly runId: string };

// The 1031 shape: every run completed, native subagents launched by earlier runs.
const stranded: ReadonlyArray<Subagent> = [
  { id: "a", title: "Audit settings sync across machines", runId: "run:2" },
  { id: "b", title: "Migrate the machine settings schema", runId: "run:3" },
  { id: "c", title: "Write settings sync tests", runId: "run:3" },
];

const OUTAGE = "Stopped when Claude's usage limit ended the parent's session";

function turnItems(
  subagents: ReadonlyArray<Subagent>,
  status: "running" | "interrupted" | "cancelled",
  command = false,
) {
  return [
    ...subagents.map((subagent, index) => ({
      id: `item:${subagent.id}`,
      runId: subagent.runId,
      type: "subagent" as const,
      status,
      title: subagent.title,
      prompt: subagent.title,
      origin: "provider_native",
      childThreadId: `thread:child:${subagent.id}`,
      nativeItemRef: { nativeId: `task:${subagent.id}` },
      ordinal: 10 + index,
      ...(status === "running"
        ? {}
        : { progress: status === "cancelled" ? "Stopped by you" : OUTAGE }),
    })),
    ...(command
      ? [
          {
            id: "item:dev-server",
            runId: "run:4",
            type: "command_execution" as const,
            status: "running" as const,
            title: null,
            input: "vp run dev --share",
            nativeItemRef: { nativeId: "shell:dev" },
          },
        ]
      : []),
  ];
}

const views: Record<string, ReturnType<typeof turnItems>> = {
  "strip-working": turnItems(stranded, "running"),
  "strip-one": turnItems(stranded.slice(0, 1), "running"),
  "strip-mixed": turnItems(stranded.slice(1), "running", true),
  // After the sweep (or a new process) settles them as an outage, and after Stop.
  "strip-settled": turnItems(stranded, "interrupted"),
  "strip-stopped": turnItems(stranded, "cancelled"),
};

const runs = [1, 2, 3, 4].map((ordinal) => ({
  id: `run:${ordinal}`,
  ordinal,
  status: "completed" as const,
}));

export function StripFixture({ view }: { readonly view: string }) {
  const items = views[view] ?? views["strip-working"]!;
  const presentation = presentPendingBackgroundWork(
    derivePendingBackgroundWork({
      latestRun: runs.at(-1),
      providerThreads: [{ id: "provider-thread", pendingBackgroundTasks: [] }],
      turnItems: items as never,
      activeProviderThreadId: "provider-thread",
      runs,
    }),
  );
  const banner: ComposerBannerStackItem | null =
    presentation === null
      ? null
      : {
          id: "background-work:thread:coordinator",
          variant: "default",
          priority: "activity",
          icon: <BackgroundWorkIcon kind={presentation.kind} running={presentation.waiting} />,
          title: (
            <BackgroundWorkLabel
              presentation={presentation}
              onOpenRelatedThread={() => undefined}
            />
          ),
          actions: (
            <BackgroundWorkStopButton stopping={false} disabled={false} onStop={() => undefined} />
          ),
        };
  return (
    <div
      data-strip-fixture={view}
      data-strip-title={presentation?.title ?? ""}
      className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end bg-background p-3 text-foreground"
    >
      {/* The composer's own shell, dock and column, as ChatComposer mounts the stack. */}
      <ComposerSurface.Shell>
        <ComposerBanner.Dock>
          <ComposerBanner.Column>
            <ComposerBannerStack items={banner === null ? [] : [banner]} />
          </ComposerBanner.Column>
        </ComposerBanner.Dock>
        <div className="relative rounded-3xl border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
          Message the coordinator…
        </div>
      </ComposerSurface.Shell>
    </div>
  );
}
