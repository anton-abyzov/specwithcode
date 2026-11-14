import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MachinePackageManager,
  MachineReadinessToolId,
  MachineToolsCheck,
  MachineToolStatus,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  IDLE_MACHINE_TOOL_INSTALL,
  machineToolInstallAtom,
  machineTools,
} from "../../studio/machineTools";

export const MACHINE_TOOL_NAMES: Readonly<Record<MachineReadinessToolId, string>> = {
  git: "Git",
  node: "Node.js",
  gh: "GitHub CLI",
  specweave: "SpecWeave",
};

/** Where to get a tool by hand when the app cannot install it on this machine. */
export const MACHINE_TOOL_DOWNLOADS: Readonly<Record<MachineReadinessToolId, string>> = {
  git: "https://git-scm.com/downloads",
  node: "https://nodejs.org/en/download",
  gh: "https://cli.github.com",
  specweave: "https://www.npmjs.com/package/specweave",
};

/**
 * One tool's state from a check. A machine on a SpecWithCode from before
 * machine readiness answers only presence for Git, Node.js and gh, and
 * nothing for SpecWeave (null).
 */
export function machineToolStatus(
  check: MachineToolsCheck,
  tool: MachineReadinessToolId,
): MachineToolStatus | null {
  const reported = check.tools?.find((entry) => entry.tool === tool);
  if (reported !== undefined) return reported;
  if (tool === "specweave") return null;
  return {
    tool,
    presence: check[tool],
    version: null,
    managed: false,
    outdated: false,
    canInstall: check.installable.includes(tool),
  };
}

/** What "Install everything" runs, in order: Git last, since its installer may take over. */
export function installTargets(check: MachineToolsCheck): ReadonlyArray<MachineReadinessToolId> {
  return (["node", "gh", "specweave", "git"] as const).filter((tool) => {
    const status = machineToolStatus(check, tool);
    return (
      status !== null &&
      status.canInstall &&
      (status.presence === "missing" || (status.outdated && status.managed))
    );
  });
}

/** The command a person runs to install Git with their Linux distribution's package manager. */
export function linuxGitCommand(manager: MachinePackageManager | null): string | null {
  switch (manager) {
    case "apt":
      return "sudo apt install git";
    case "dnf":
      return "sudo dnf install git";
    case "pacman":
      return "sudo pacman -S git";
    case "zypper":
      return "sudo zypper install git";
    default:
      return null;
  }
}

/** While macOS's own window installs its developer tools, the machine is asked again this often. */
const HANDED_OFF_POLL_MS = 5_000;
/** That download can take a while; asking stops after this many tries. */
const HANDED_OFF_POLL_LIMIT = 240;

export type MachineToolsCheckState =
  | { readonly kind: "checking" }
  /** The machine runs a SpecWithCode that cannot answer, or refused the read. */
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly check: MachineToolsCheck };

/**
 * Asks a machine which basics it has, and runs one install there at a time.
 * A finished install is followed by a fresh check, and an install macOS took
 * over in its own window is checked again until the tool appears.
 */
export function useMachineTools(environmentId: EnvironmentId, enabled = true) {
  const checkCommand = useAtomCommand(machineTools.check, { reportFailure: false });
  const installCommand = useAtomCommand(machineTools.install, { reportFailure: false });
  const install = useAtomValue(machineToolInstallAtom(environmentId));
  const setInstall = useAtomSet(machineToolInstallAtom(environmentId));
  const [state, setState] = useState<MachineToolsCheckState>({ kind: "checking" });
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++request.current;
    const result = await checkCommand({ environmentId, input: {} });
    if (request.current !== mine) return;
    setState(
      result._tag === "Success" ? { kind: "ready", check: result.value } : { kind: "unavailable" },
    );
  }, [checkCommand, environmentId]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  // An install that ended before this opened is history: no stale log, no waiting on macOS.
  // One still running stays on screen.
  const opened = useRef(install.status);
  useEffect(() => {
    if (opened.current === "done" || opened.current === "failed")
      setInstall(IDLE_MACHINE_TOOL_INSTALL);
  }, [setInstall]);

  // An install ending is read again, so its row turns ready or says what is left.
  const status = install.status;
  const seen = useRef(status);
  useEffect(() => {
    const before = seen.current;
    seen.current = status;
    if (before !== status && (status === "done" || status === "failed")) void refresh();
  }, [status, refresh]);

  const waitingFor =
    install.status === "done" && install.handedOff && install.tool !== null ? install.tool : null;
  const stillMissing =
    waitingFor !== null &&
    state.kind === "ready" &&
    machineToolStatus(state.check, waitingFor)?.presence === "missing";
  useEffect(() => {
    if (!stillMissing) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > HANDED_OFF_POLL_LIMIT) {
        clearInterval(timer);
        return;
      }
      void refresh();
    }, HANDED_OFF_POLL_MS);
    return () => clearInterval(timer);
  }, [stillMissing, refresh]);

  const start = useCallback(
    (tool: MachineReadinessToolId) => void installCommand({ environmentId, input: { tool } }),
    [installCommand, environmentId],
  );

  // Install everything: one tool after another, each from a fresh check, until
  // one fails or the list is done. A closed view stops the queue, not the install.
  const [queue, setQueue] = useState<ReadonlyArray<MachineReadinessToolId>>([]);
  const startAll = useCallback(
    (tools: ReadonlyArray<MachineReadinessToolId>) => {
      // An earlier install's ending is not this queue's: a failed Node.js must not stop it.
      if (install.status !== "running") setInstall(IDLE_MACHINE_TOOL_INSTALL);
      setQueue(tools);
    },
    [install.status, setInstall],
  );
  const queued = queue[0];
  useEffect(() => {
    if (queued === undefined || install.status === "running") return;
    if (install.tool === queued && install.status === "failed") {
      setQueue([]);
      return;
    }
    if (install.tool === queued && install.status === "done") {
      setQueue((rest) => rest.slice(1));
      return;
    }
    void installCommand({ environmentId, input: { tool: queued } });
  }, [queued, install.status, install.tool, installCommand, environmentId]);

  return { state, install, refresh, start, startAll, installingAll: queue.length > 0 };
}

/** An install's own log lines, the latest in view, and how it ended. */
export function MachineToolLog({
  lines,
  status,
  detail,
}: {
  readonly lines: ReadonlyArray<string>;
  readonly status: "idle" | "running" | "done" | "failed";
  readonly detail: string | null;
}) {
  const tx = useTx();
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [lines.length]);
  if (status === "idle") return null;
  return (
    <div className="mt-2 text-xs" data-machine-tool-log={status}>
      <div
        role="log"
        aria-label={tx("Install log")}
        className="max-h-40 overflow-y-auto rounded-md border bg-muted/40 px-3 py-2 font-mono leading-relaxed break-all whitespace-pre-wrap text-muted-foreground"
      >
        {lines.length === 0 ? tx("Starting…") : lines.join("\n")}
        <div ref={end} />
      </div>
      {detail && status !== "running" ? (
        <p
          role={status === "failed" ? "alert" : "status"}
          className={
            status === "failed" ? "mt-1.5 text-warning-foreground" : "mt-1.5 text-muted-foreground"
          }
        >
          {detail}
        </p>
      ) : null}
    </div>
  );
}
