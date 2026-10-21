import { EnvironmentId, ScheduledTaskId } from "@specweave-studio/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/ScheduledTaskLink", () => ({
  ScheduledTaskLink: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a href="#routine" className={className}>
      {children}
    </a>
  ),
}));

import { parseRoutineRunMessage } from "../../studio/routineRunMessage";
import { RoutineRunCard } from "./RoutineRunCard";
import { structuredFenceView } from "../chat/StructuredBlocks";

const TEXT =
  'Routine "New Relic repair watch" fired. Answer it yourself or start the threads it needs.\n\n' +
  "Process every due job. Keep receipts under ~/.local/share/receipts/.\n\n" +
  'The check `due-check.sh` passed. Its output:\n```\n{"queue": {"escalated": 2, "pending": 1}, "worker": {"last_claim_at": "2026-10-21T08:22:41.586Z", "oldest_due_age_seconds": 1534}, "monitor_error": null}\n```';

function card(text: string) {
  return renderToStaticMarkup(
    <RoutineRunCard
      run={parseRoutineRunMessage({ id: "scheduled-task-message:t:a:b:scheduled", text })}
      environmentId={EnvironmentId.make("env")}
      taskId={ScheduledTaskId.make("t")}
      cadence="Every 5 min"
      time="10:22 AM"
      fullText={text}
      renderMarkdown={(part) => <p>{part}</p>}
    />,
  );
}

describe("RoutineRunCard", () => {
  it("shows the routine, how it fired, the check and its output as fields", () => {
    const html = card(TEXT);
    expect(html).toContain("New Relic repair watch");
    expect(html).toContain("Every 5 min");
    expect(html).toContain("Check passed");
    expect(html).toContain("due-check.sh");
    expect(html).toContain("Escalated");
    expect(html).toContain("Oldest due age seconds");
    expect(html).toContain("25m 34s");
    expect(html).toContain("Process every due job.");
    expect(html).not.toContain("Answer it yourself");
    expect(html).not.toContain("&quot;queue&quot;");
  });

  it("keeps plain check output as text", () => {
    const html = card(TEXT.replace(/```\n\{[\s\S]*\}\n```/, "```\n3 jobs due\n```"));
    expect(html).toContain("3 jobs due");
    expect(html).not.toContain("<dl");
  });
});

describe("structuredFenceView", () => {
  it("renders status, kv and json fences, and declines text it cannot read", () => {
    const status = renderToStaticMarkup(
      <>{structuredFenceView("status", "ok: Build\nfail: Deploy | waiting")}</>,
    );
    expect(status).toContain('data-status-state="fail"');
    expect(status).toContain("waiting");
    const kv = renderToStaticMarkup(<>{structuredFenceView("kv", "# Queue\nPending: 1")}</>);
    expect(kv).toContain("Pending");
    const table = renderToStaticMarkup(
      <>{structuredFenceView("json", '[{"job":"a","state":"ok"},{"job":"b","state":"late"}]')}</>,
    );
    expect(table).toContain("<table");
    expect(table).toContain("late");
    expect(structuredFenceView("status", "just prose")).toBeNull();
    expect(structuredFenceView("json", "{broken")).toBeNull();
  });
});
