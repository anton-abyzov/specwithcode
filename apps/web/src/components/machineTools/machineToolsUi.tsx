import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MachinePackageManager,
  MachineToolId,
  MachineToolsCheck,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { useTx } from "../../i18n";
import { useAtomCommand } from "../../state/use-atom-command";
import { machineToolInstallAtom, machineTools } from "../../studio/machineTools";

export const MACHINE_TOOL_NAMES: Readonly<Record<MachineToolId, string>> = {
  git: "Git",
  node: "Node.js",
  gh: "GitHub CLI",
};

/** Where to get a tool by hand when the app cannot install it on this machine. */
export const MACHINE_TOOL_DOWNLOADS: Readonly<Record<MachineToolId, string>> = {
  git: "https://git-scm.com/downloads",
  node: "https://nodejs.org/en/download",
  gh: "https://cli.github.com",
};

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

  // A finished install is read again, so its row turns ready or says what is left.
  const status = install.status;
  useEffect(() => {
    if (status === "done" || status === "failed") void refresh();
  }, [status, refresh]);

  const waitingFor =
    install.status === "done" && install.handedOff && install.tool !== null ? install.tool : null;
  const stillMissing =
    waitingFor !== null && state.kind === "ready" && state.check[waitingFor] === "missing";
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
    (tool: MachineToolId) => void installCommand({ environmentId, input: { tool } }),
    [installCommand, environmentId],
  );

  return { state, install, refresh, start };
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
