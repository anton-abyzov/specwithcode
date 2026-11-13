/*
 * Headless preview of the restart and update questions with running work.
 * ?scene=before reproduces origin/main's service update question (text only);
 * ?scene=after and ?scene=remote show the live list. Nothing restarts.
 */
import type { ServiceUpdateBlocker } from "@specweave-studio/contracts";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { requestConfirmDialog } from "../../src/confirmDialog";
import { ConfirmDialogHost } from "../../src/components/ConfirmDialogHost";
import { askRestartForWork } from "../../src/components/serviceUpdateCalls";
import {
  LiveRestartRunningWorkList,
  RestartDialogNotes,
} from "../../src/components/sidebar/RestartRunningWorkList";
import { describeListedRestart } from "../../src/components/sidebar/restartRunningWork.logic";
import {
  describeReaskedRequests,
  describeServiceUpdateStop,
  restartWhenIdleNote,
} from "../../src/components/sidebar/SidebarRestartToUpdate.logic";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "after";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const blocker = (
  threadId: string,
  threadTitle: string,
  projectTitle: string,
  kind: ServiceUpdateBlocker["kind"] = "run",
): ServiceUpdateBlocker =>
  ({
    kind,
    count: 1,
    threadId,
    threadTitle,
    projectId: projectTitle,
    projectTitle,
    continuesAfterRestart: true,
  }) as unknown as ServiceUpdateBlocker;

const running = [
  blocker("thread-1", "Release all platforms", "specweave-umb"),
  blocker("thread-2", "Fix Windows installer signing", "specwithcode"),
  blocker("thread-3", "Model picker: provider logos", "specwithcode"),
  blocker("thread-4", "SpecOS nightly sync", "SpecOS", "queued"),
];
const question = blocker("thread-5", "Draft LinkedIn post", "marketing", "request");
const all = [...running, { ...question, questions: 1, approvals: 0, waitsOnPerson: true }];

// The live list: after the first look one thread finished (thread-3).
let looks = 0;
const poll = async () => {
  looks += 1;
  return looks >= 1 ? running.filter((row) => row.threadId !== "thread-3") : running;
};
Object.assign(window, { __looks: () => looks });

function Fixture() {
  // The question is asked once the host has registered (its own effect runs first).
  useEffect(() => ask(), []);
  return <ConfirmDialogHost />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);

function ask() {
  if (scene === "before") {
    // origin/main's question when the service updates first: text only, no list, no wait.
    void requestConfirmDialog(
      describeServiceUpdateStop({ blockers: all, openTerminals: 1, folderCopies: 0 })!,
      { variant: "destructive", confirmLabel: "Stop and update now", cancelLabel: "Cancel" },
    );
    return;
  }
  const remote = scene === "remote";
  void askRestartForWork(
    describeListedRestart({
      title: remote ? "Update M1 to 1.0.262?" : "Restart to install SpecWithCode 1.0.262?",
      continues: true,
      openTerminals: remote ? 0 : 1,
    }),
    {
      canWait: true,
      ...(remote ? { nowLabel: "Update now" } : {}),
      details: (
        <div className="space-y-3">
          <LiveRestartRunningWorkList
            initial={running}
            poll={params.get("live") === "1" ? poll : undefined}
            intervalMs={1_000}
            machine={{ environmentId: remote ? "env-m1" : "env-m4", name: remote ? "M1" : "M4" }}
            onOpenThread={(thread) => {
              document.body.dataset.opened = `${thread.environmentId}/${thread.threadId}`;
            }}
          />
          <RestartDialogNotes lines={[describeReaskedRequests(all), restartWhenIdleNote(10)]} />
        </div>
      ),
    },
  );
}
